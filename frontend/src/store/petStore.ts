import { create } from 'zustand';
import { onActivity, type ActivityEvent } from '../utils/activityBus';
import { analyzeSentiment } from '../utils/sentimentAnalyzer';
import { log } from '../utils/logger';

// ── Task & Emotion types (from notchi) ──

export type PetTask = 'idle' | 'working' | 'sleeping' | 'compacting' | 'waiting';
export type PetEmotion = 'neutral' | 'happy' | 'sad' | 'sob';

export interface TaskConfig {
  fps: number;
  frames: number;
  bobDuration: number;   // seconds
  bobAmplitude: number;  // pixels
}

export const TASK_CONFIGS: Record<PetTask, TaskConfig> = {
  idle:       { fps: 3,  frames: 6, bobDuration: 1.5, bobAmplitude: 1.5 },
  working:    { fps: 4,  frames: 6, bobDuration: 0.4, bobAmplitude: 0.5 },
  sleeping:   { fps: 2,  frames: 6, bobDuration: 4.0, bobAmplitude: 0 },
  compacting: { fps: 6,  frames: 5, bobDuration: 0.5, bobAmplitude: 1.0 },
  waiting:    { fps: 3,  frames: 6, bobDuration: 1.5, bobAmplitude: 1.0 },
};

// Emotion sway amplitude (degrees)
export const EMOTION_SWAY: Record<PetEmotion, number> = {
  happy: 1.0,
  neutral: 0.5,
  sad: 0.25,
  sob: 0.15,
};

// ── Sprite sheet lookup ──

const SPRITE_SHEETS: Record<string, boolean> = {
  'idle_happy': true, 'idle_neutral': true, 'idle_sad': true, 'idle_sob': true,
  'working_happy': true, 'working_neutral': true, 'working_sad': true, 'working_sob': true,
  'waiting_happy': true, 'waiting_neutral': true, 'waiting_sad': true, 'waiting_sob': true,
  'sleeping_happy': true, 'sleeping_neutral': true,
  'compacting_happy': true, 'compacting_neutral': true,
};

export function getSpriteSheet(task: PetTask, emotion: PetEmotion): string {
  const exact = `${task}_${emotion}`;
  if (SPRITE_SHEETS[exact]) return `/sprites/${exact}.png`;
  if (emotion === 'sob') {
    const sad = `${task}_sad`;
    if (SPRITE_SHEETS[sad]) return `/sprites/${sad}.png`;
  }
  return `/sprites/${task}_neutral.png`;
}

// ── Thresholds ──

const IDLE_TIMEOUT = 10_000;     // 10s no activity → idle
const SLEEP_TIMEOUT = 300_000;   // 5min no activity → sleeping
const WAITING_TIMEOUT = 30_000;  // 30s after claude ends → waiting
const LONELY_START = 60_000;     // 1min idle → start getting sad
const LONELY_DEEP = 180_000;     // 3min idle → sadder faster

const HAPPY_THRESHOLD = 0.4;
const SAD_THRESHOLD = 0.3;
const SOB_THRESHOLD = 0.7;
const EMOTION_DAMPENING = 0.75;
const INTER_EMOTION_DECAY = 0.5;
const EMOTION_DECAY_RATE = 0.85;
const EMOTION_DECAY_INTERVAL = 60_000; // 60s

// ── Individual pet state ──

export interface IndividualPetState {
  task: PetTask;
  emotion: PetEmotion;
  emotionScores: { happy: number; sad: number };
  walkX: number;
  walkTarget: number;
  walkDirection: 1 | -1;
  lastActivity: number;
  claudeStreaming: boolean;
  speechBubble: string | null;
}

function createDefaultPetState(): IndividualPetState {
  return {
    task: 'idle',
    emotion: 'neutral',
    emotionScores: { happy: 0, sad: 0 },
    walkX: 0.2 + Math.random() * 0.6,
    walkTarget: 0.5,
    walkDirection: 1,
    lastActivity: Date.now(),
    claudeStreaming: false,
    speechBubble: null,
  };
}

// ── Helpers ──

function resolveEmotion(scores: { happy: number; sad: number }): PetEmotion {
  // Sob only if sad is dominant AND above sob threshold
  if (scores.sad >= SOB_THRESHOLD && scores.sad > scores.happy) return 'sob';
  // When both emotions are above their thresholds, the higher score wins
  if (scores.happy >= HAPPY_THRESHOLD && scores.happy >= scores.sad) return 'happy';
  if (scores.sad >= SAD_THRESHOLD) return 'sad';
  if (scores.happy >= HAPPY_THRESHOLD) return 'happy';
  return 'neutral';
}

function addEmotion(
  scores: { happy: number; sad: number },
  type: 'happy' | 'sad',
  intensity: number,
): { happy: number; sad: number } {
  const next = { ...scores };
  const other = type === 'happy' ? 'sad' : 'happy';
  next[type] = Math.min(1, next[type] + intensity * EMOTION_DAMPENING);
  next[other] = next[other] * INTER_EMOTION_DECAY;
  return next;
}

const SPEECH_PHRASES: Record<PetTask, string[]> = {
  idle: ['...', 'Hey!', ':)', 'Bored...'],
  working: ['Coding!', 'Busy...', 'Almost done!', 'On it!'],
  sleeping: ['Zzz...', '*yawn*', '5 more minutes...'],
  compacting: ['Compacting!', 'Cleaning up...', 'Tidying...'],
  waiting: ['Waiting...', 'Your turn!', 'Ready?', 'Hello?'],
};

const EMOTION_PHRASES: Partial<Record<PetEmotion, string[]>> = {
  sad: ['Miss you...', '*sigh*', 'Lonely...', 'Come back?'],
  sob: ['*crying*', 'So alone...', 'Please...', 'Where are you?'],
};

const speechTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Store ──

interface PetStoreState {
  // Pets keyed by terminal instanceId (only Claude terminals: "claude-*")
  pets: Record<string, IndividualPetState>;
  selectedPetId: string | null;
  viewMode: 'single' | 'all';

  processEvent: (event: ActivityEvent) => void;
  tap: (id: string) => void;
  selectPet: (id: string) => void;
  setViewMode: (mode: 'single' | 'all') => void;
}

function updatePet(
  pets: Record<string, IndividualPetState>,
  id: string,
  patch: Partial<IndividualPetState>,
): Record<string, IndividualPetState> {
  const pet = pets[id];
  if (!pet) return pets;
  return { ...pets, [id]: { ...pet, ...patch } };
}

function updateAllPets(
  pets: Record<string, IndividualPetState>,
  patchFn: (pet: IndividualPetState) => Partial<IndividualPetState>,
): Record<string, IndividualPetState> {
  const next: Record<string, IndividualPetState> = {};
  for (const [id, pet] of Object.entries(pets)) {
    const patch = patchFn(pet);
    next[id] = { ...pet, ...patch };
  }
  return next;
}

export const usePetStore = create<PetStoreState>((set, get) => ({
  pets: {},
  selectedPetId: null,
  viewMode: 'all',

  processEvent: (event: ActivityEvent) => {
    const now = Date.now();
    const state = get();

    switch (event.type) {
      // ── Terminal lifecycle — only create pets for Claude terminals ──

      case 'terminal_connect': {
        // Pet is NOT created here — only via 'claude_launched' from ChatPanel.
        break;
      }

      case 'claude_launched': {
        const id = event.instanceId;
        if (state.pets[id]) return; // already exists
        const newPet = createDefaultPetState();
        const selected = state.selectedPetId ?? id;
        set({ pets: { ...state.pets, [id]: newPet }, selectedPetId: selected });
        log('[PetStore] Claude launched, pet created:', id);
        break;
      }

      case 'terminal_disconnect': {
        const id = event.instanceId;
        if (!state.pets[id]) return; // not a pet terminal
        const { [id]: _, ...rest } = state.pets;
        const timer = speechTimers.get(id);
        if (timer) { clearTimeout(timer); speechTimers.delete(id); }
        // Remaining pets get sad when a companion leaves
        const sadRest: Record<string, IndividualPetState> = {};
        for (const [rid, rpet] of Object.entries(rest)) {
          const scores = addEmotion(rpet.emotionScores, 'sad', 0.2);
          sadRest[rid] = { ...rpet, emotionScores: scores, emotion: resolveEmotion(scores) };
        }
        const ids = Object.keys(sadRest);
        let selected = state.selectedPetId;
        if (selected === id) selected = ids[0] ?? null;
        set({ pets: sadRest, selectedPetId: selected });
        log('[PetStore] Claude terminal disconnected, pet removed:', id);
        break;
      }

      // ── Terminal activity — only affects existing pets (Claude terminals) ──

      case 'terminal_input': {
        const id = event.instanceId;
        const pet = state.pets[id];
        if (!pet) return;
        // No emotion boost here — emotions come from terminal_prompt_submit (sentiment)
        const patch: Partial<IndividualPetState> = { lastActivity: now };
        if (pet.task === 'sleeping' || pet.task === 'waiting') {
          patch.task = 'idle';
        }
        set({ pets: updatePet(state.pets, id, patch) });
        break;
      }

      case 'terminal_data': {
        const id = event.instanceId;
        if (event.byteCount < 50) break;
        const pet = state.pets[id];
        if (!pet) break;
        // Task change → always update
        if (pet.task === 'idle' || pet.task === 'waiting' || pet.task === 'sleeping') {
          set({ pets: updatePet(state.pets, id, { task: 'working', lastActivity: now }) });
        } else if (now - pet.lastActivity > 2000) {
          // Already working — throttle lastActivity updates (timer runs every 2s)
          set({ pets: updatePet(state.pets, id, { lastActivity: now }) });
        }
        break;
      }

      case 'terminal_streaming_start': {
        const id = event.instanceId;
        if (!state.pets[id]) return;
        set({ pets: updatePet(state.pets, id, {
          task: 'working',
          claudeStreaming: true,
          lastActivity: now,
        }) });
        break;
      }

      case 'terminal_streaming_end': {
        const id = event.instanceId;
        const pet = state.pets[id];
        if (!pet) return;
        const scores = addEmotion(pet.emotionScores, 'happy', 0.3);
        set({ pets: updatePet(state.pets, id, {
          task: 'idle',
          claudeStreaming: false,
          lastActivity: now,
          emotionScores: scores,
          emotion: resolveEmotion(scores),
        }) });
        break;
      }

      // ── User prompt sentiment → emotion (like notchi UserPromptSubmit) ──

      case 'terminal_prompt_submit': {
        const id = event.instanceId;
        const pet = state.pets[id];
        if (!pet) break;

        const result = analyzeSentiment(event.text);
        log(`[PetStore] sentiment: "${event.text.slice(0, 40)}" → ${result.emotion} (${result.intensity.toFixed(2)})`);

        let newScores: { happy: number; sad: number };
        if (result.emotion === 'neutral') {
          // Neutral counter-decay (notchi: neutralCounterDecay = 0.85)
          newScores = {
            happy: pet.emotionScores.happy * 0.85,
            sad: pet.emotionScores.sad * 0.85,
          };
        } else {
          newScores = addEmotion(pet.emotionScores, result.emotion, result.intensity);
        }

        // User submitted prompt → working (before Claude even responds)
        set({ pets: updatePet(state.pets, id, {
          task: 'working',
          lastActivity: now,
          emotionScores: newScores,
          emotion: resolveEmotion(newScores),
        }) });
        break;
      }

      // ── Claude WebSocket chat events (DEAD CODE) ──
      // ChatPanel запускает Claude в терминалах, не через WebSocket chat API.
      // Оставлено на случай перехода на WS chat. Влияет на ALL pets.

      case 'claude_stream_start':
      case 'claude_stream_delta': {
        if (Object.keys(state.pets).length === 0) break;
        const newPets = updateAllPets(state.pets, () => ({
          task: 'working' as PetTask,
          claudeStreaming: true,
          lastActivity: now,
        }));
        set({ pets: newPets });
        break;
      }

      case 'claude_stream_end': {
        if (Object.keys(state.pets).length === 0) break;
        const newPets = updateAllPets(state.pets, (pet) => {
          const scores = addEmotion(pet.emotionScores, 'happy', 0.3);
          return {
            claudeStreaming: false,
            lastActivity: now,
            emotionScores: scores,
            emotion: resolveEmotion(scores),
          };
        });
        set({ pets: newPets });
        break;
      }

      case 'claude_error': {
        if (Object.keys(state.pets).length === 0) break;
        const newPets = updateAllPets(state.pets, (pet) => {
          const scores = addEmotion(pet.emotionScores, 'sad', 0.3);
          return {
            lastActivity: now,
            emotionScores: scores,
            emotion: resolveEmotion(scores),
          };
        });
        set({ pets: newPets });
        break;
      }

      // ── Claude Code hooks (via backend → Redis → sync WS) ──
      // Maps real Claude Code events to pet task/emotion transitions (like notchi).

      case 'claude_hook': {
        const id = event.instanceId;
        const pet = state.pets[id];

        switch (event.event) {
          case 'UserPromptSubmit': {
            // User submitted prompt → working + sentiment analysis
            if (pet) {
              const result = analyzeSentiment(event.userPrompt || '');
              let newScores: { happy: number; sad: number };
              if (result.emotion === 'neutral') {
                newScores = { happy: pet.emotionScores.happy * 0.85, sad: pet.emotionScores.sad * 0.85 };
              } else {
                newScores = addEmotion(pet.emotionScores, result.emotion, result.intensity);
              }
              set({ pets: updatePet(state.pets, id, {
                task: 'working', lastActivity: now,
                emotionScores: newScores, emotion: resolveEmotion(newScores),
              }) });
            }
            break;
          }
          case 'PreCompact': {
            // Claude auto-compacting context → compacting task
            if (pet) {
              set({ pets: updatePet(state.pets, id, { task: 'compacting', lastActivity: now }) });
            }
            break;
          }
          case 'PreToolUse': {
            // Claude about to use a tool
            if (pet) {
              if (event.tool === 'AskUserQuestion') {
                // Waiting for user input
                set({ pets: updatePet(state.pets, id, { task: 'waiting', lastActivity: now }) });
              } else {
                set({ pets: updatePet(state.pets, id, { task: 'working', lastActivity: now }) });
              }
            }
            break;
          }
          case 'PermissionRequest': {
            // Claude waiting for permission → waiting
            if (pet) {
              set({ pets: updatePet(state.pets, id, { task: 'waiting', lastActivity: now }) });
            }
            break;
          }
          case 'PostToolUse': {
            // Tool finished → back to working
            if (pet) {
              set({ pets: updatePet(state.pets, id, { task: 'working', lastActivity: now }) });
            }
            break;
          }
          case 'Stop':
          case 'SubagentStop': {
            // Claude finished → idle
            if (pet) {
              const scores = addEmotion(pet.emotionScores, 'happy', 0.15);
              set({ pets: updatePet(state.pets, id, {
                task: 'idle', claudeStreaming: false, lastActivity: now,
                emotionScores: scores, emotion: resolveEmotion(scores),
              }) });
            }
            break;
          }
          case 'SessionStart': {
            // New Claude session started
            if (pet) {
              set({ pets: updatePet(state.pets, id, { task: 'idle', lastActivity: now }) });
            }
            break;
          }
          case 'SessionEnd': {
            // Claude session ended → idle
            if (pet) {
              set({ pets: updatePet(state.pets, id, { task: 'idle', claudeStreaming: false, lastActivity: now }) });
            }
            break;
          }
        }
        break;
      }

      // ── Global events ──

      case 'file_save': {
        if (Object.keys(state.pets).length === 0) break;
        const newPets = updateAllPets(state.pets, (pet) => {
          const scores = addEmotion(pet.emotionScores, 'happy', 0.4);
          return {
            lastActivity: now,
            emotionScores: scores,
            emotion: resolveEmotion(scores),
          };
        });
        set({ pets: newPets });
        break;
      }
    }
  },

  tap: (id: string) => {
    const state = get();
    const pet = state.pets[id];
    if (!pet) return;
    const scores = addEmotion(pet.emotionScores, 'happy', 0.2);
    const emotionList = EMOTION_PHRASES[pet.emotion];
    const list = emotionList || SPEECH_PHRASES[pet.task];
    const bubble = list[Math.floor(Math.random() * list.length)];
    set({ pets: updatePet(state.pets, id, {
      emotionScores: scores,
      emotion: resolveEmotion(scores),
      speechBubble: bubble,
    }) });
    const prev = speechTimers.get(id);
    if (prev) clearTimeout(prev);
    speechTimers.set(id, setTimeout(() => {
      speechTimers.delete(id);
      const s = usePetStore.getState();
      usePetStore.setState({ pets: updatePet(s.pets, id, { speechBubble: null }) });
    }, 2000));
  },

  selectPet: (id: string) => {
    set({ selectedPetId: id });
  },

  setViewMode: (mode: 'single' | 'all') => {
    const state = get();
    if (mode === 'single' && !state.selectedPetId) {
      const ids = Object.keys(state.pets);
      set({ viewMode: mode, selectedPetId: ids[0] ?? null });
    } else {
      set({ viewMode: mode });
    }
  },
}));

// ── Module-level timers ──

const timers: {
  task: ReturnType<typeof setInterval> | null;
  emotion: ReturnType<typeof setInterval> | null;
  walk: ReturnType<typeof setTimeout> | null;
} = { task: null, emotion: null, walk: null };

function startTimers() {
  if (timers.task) return;

  // Task state transitions + loneliness (every 2s)
  timers.task = setInterval(() => {
    const { pets } = usePetStore.getState();
    const now = Date.now();
    let changed = false;
    const next: Record<string, IndividualPetState> = {};

    for (const [id, pet] of Object.entries(pets)) {
      const elapsed = now - pet.lastActivity;
      let newTask = pet.task;
      let newScores = pet.emotionScores;
      let scoresChanged = false;

      if (!pet.claudeStreaming) {
        // Task transitions: working → idle (10s) → waiting (30s) → sleeping (5min)
        if (elapsed >= SLEEP_TIMEOUT) {
          if (pet.task !== 'sleeping') newTask = 'sleeping';
        } else if (elapsed >= WAITING_TIMEOUT && pet.task === 'idle') {
          newTask = 'waiting';
        } else if (elapsed >= IDLE_TIMEOUT && pet.task === 'working') {
          newTask = 'idle';
        }

        // Loneliness
        if (elapsed >= LONELY_DEEP) {
          newScores = { happy: newScores.happy * 0.95, sad: Math.min(1, newScores.sad + 0.03) };
          scoresChanged = true;
        } else if (elapsed >= LONELY_START) {
          newScores = { happy: newScores.happy * 0.97, sad: Math.min(1, newScores.sad + 0.015) };
          scoresChanged = true;
        }
      }

      if (newTask !== pet.task || scoresChanged) {
        if (newTask !== pet.task) {
          log(`[PetStore] ${id}: ${pet.task} → ${newTask} (elapsed=${Math.round(elapsed / 1000)}s)`);
        }
        next[id] = {
          ...pet,
          task: newTask,
          ...(scoresChanged ? { emotionScores: newScores, emotion: resolveEmotion(newScores) } : {}),
        };
        changed = true;
      } else {
        next[id] = pet;
      }
    }

    if (changed) usePetStore.setState({ pets: next });
  }, 2000);

  // Emotion decay (every 60s)
  timers.emotion = setInterval(() => {
    const { pets } = usePetStore.getState();
    const next: Record<string, IndividualPetState> = {};
    for (const [id, pet] of Object.entries(pets)) {
      const scores = {
        happy: pet.emotionScores.happy * EMOTION_DECAY_RATE,
        sad: pet.emotionScores.sad * EMOTION_DECAY_RATE,
      };
      next[id] = { ...pet, emotionScores: scores, emotion: resolveEmotion(scores) };
    }
    usePetStore.setState({ pets: next });
  }, EMOTION_DECAY_INTERVAL);

  // Random walk (every 8-15s)
  function scheduleWalk() {
    const delay = 8000 + Math.random() * 7000;
    timers.walk = setTimeout(() => {
      const { pets } = usePetStore.getState();
      const ids = Object.keys(pets);
      if (ids.length === 0) { scheduleWalk(); return; }
      const id = ids[Math.floor(Math.random() * ids.length)];
      const pet = pets[id];
      if (pet && pet.task !== 'sleeping' && pet.task !== 'waiting' && pet.emotion !== 'sob') {
        const target = Math.random();
        const dir = target > pet.walkX ? 1 : -1;
        usePetStore.setState({
          pets: updatePet(pets, id, { walkTarget: target, walkDirection: dir as 1 | -1 }),
        });
      }
      scheduleWalk();
    }, delay);
  }
  scheduleWalk();
}

// Subscribe to activity bus
onActivity((event) => usePetStore.getState().processEvent(event));

// Start timers immediately (module-level)
startTimers();
