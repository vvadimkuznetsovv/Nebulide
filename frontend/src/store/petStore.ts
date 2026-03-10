import { create } from 'zustand';
import { onActivity, type ActivityEvent } from '../utils/activityBus';

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
  // Fallback: sob → sad → neutral
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

const HAPPY_THRESHOLD = 0.6;
const SAD_THRESHOLD = 0.45;
const SOB_THRESHOLD = 0.9;
const EMOTION_DAMPENING = 0.5;
const INTER_EMOTION_DECAY = 0.9;
const EMOTION_DECAY_RATE = 0.92;
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
  claudeEndedAt: number;
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
    claudeEndedAt: 0,
    speechBubble: null,
  };
}

// ── Helpers ──

function resolveEmotion(scores: { happy: number; sad: number }): PetEmotion {
  if (scores.sad >= SOB_THRESHOLD) return 'sob';
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

// Emotion-specific speech overrides
const EMOTION_PHRASES: Partial<Record<PetEmotion, string[]>> = {
  sad: ['Miss you...', '*sigh*', 'Lonely...', 'Come back?'],
  sob: ['*crying*', 'So alone...', 'Please...', 'Where are you?'],
};

// Speech bubble timers per pet (module-level to survive re-renders)
const speechTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Store ──

interface PetStoreState {
  pets: Record<string, IndividualPetState>;
  selectedPetId: string | null;
  viewMode: 'single' | 'all';

  processEvent: (event: ActivityEvent) => void;
  tap: (instanceId: string) => void;
  selectPet: (instanceId: string) => void;
  setViewMode: (mode: 'single' | 'all') => void;
}

/** Update a single pet inside the pets Record, return new pets object. */
function updatePet(
  pets: Record<string, IndividualPetState>,
  id: string,
  patch: Partial<IndividualPetState>,
): Record<string, IndividualPetState> {
  const pet = pets[id];
  if (!pet) return pets;
  return { ...pets, [id]: { ...pet, ...patch } };
}

/** Apply a patch to ALL pets. */
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
      case 'terminal_connect': {
        const id = event.instanceId;
        console.log('[PetStore] terminal_connect:', id, 'existing:', !!state.pets[id], 'totalPets:', Object.keys(state.pets).length);
        if (state.pets[id]) return; // already exists
        const newPet = createDefaultPetState();
        const newPets = { ...state.pets, [id]: newPet };
        const selected = state.selectedPetId ?? id;
        set({ pets: newPets, selectedPetId: selected });
        console.log('[PetStore] pet created:', id, 'totalPets:', Object.keys(newPets).length);
        break;
      }

      case 'terminal_disconnect': {
        const id = event.instanceId;
        console.log('[PetStore] terminal_disconnect:', id, 'existing:', !!state.pets[id]);
        if (!state.pets[id]) return;
        const { [id]: _, ...rest } = state.pets;
        // Clear speech timer
        const timer = speechTimers.get(id);
        if (timer) { clearTimeout(timer); speechTimers.delete(id); }
        // Fix selection
        const ids = Object.keys(rest);
        let selected = state.selectedPetId;
        if (selected === id) selected = ids[0] ?? null;
        set({ pets: rest, selectedPetId: selected });
        break;
      }

      case 'terminal_input': {
        // User typing — small happy boost (they're engaging!), update lastActivity.
        // Don't change task — 'working' only on sustained streaming.
        const id = event.instanceId;
        const pet = state.pets[id];
        if (pet) {
          const scores = addEmotion(pet.emotionScores, 'happy', 0.08);
          set({ pets: updatePet(state.pets, id, {
            lastActivity: now,
            emotionScores: scores,
            emotion: resolveEmotion(scores),
          }) });
        }
        break;
      }
      case 'terminal_data': {
        // Terminal output (shell prompt, cursor, etc.) — ignore for pet state.
        // Only meaningful events (input, streaming, claude, file_save) update lastActivity.
        // This prevents background terminal noise from keeping pet stuck in "working".
        break;
      }

      // Sustained terminal output (e.g. Claude CLI streaming in terminal)
      case 'terminal_streaming_start': {
        const id = event.instanceId;
        set({ pets: updatePet(state.pets, id, {
          task: 'working',
          claudeStreaming: true,
          lastActivity: now,
        }) });
        break;
      }

      case 'terminal_streaming_end': {
        // Sustained terminal output ended (could be npm install, build, etc.)
        // Don't set claudeEndedAt — only claude_stream_end should trigger waiting.
        const id = event.instanceId;
        const pet = state.pets[id];
        if (pet) {
          const scores = addEmotion(pet.emotionScores, 'happy', 0.15);
          set({ pets: updatePet(state.pets, id, {
            claudeStreaming: false,
            lastActivity: now,
            emotionScores: scores,
            emotion: resolveEmotion(scores),
          }) });
        }
        break;
      }

      case 'claude_stream_start':
      case 'claude_stream_delta': {
        // Global: all pets become working + streaming
        const newPets = updateAllPets(state.pets, () => ({
          task: 'working' as PetTask,
          claudeStreaming: true,
          lastActivity: now,
        }));
        set({ pets: newPets });
        break;
      }

      case 'claude_stream_end': {
        const newPets = updateAllPets(state.pets, (pet) => {
          const scores = addEmotion(pet.emotionScores, 'happy', 0.3);
          return {
            claudeStreaming: false,
            claudeEndedAt: now,
            lastActivity: now,
            emotionScores: scores,
            emotion: resolveEmotion(scores),
          };
        });
        set({ pets: newPets });
        break;
      }

      case 'claude_error': {
        // Claude errored — all pets get a sadness boost
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

      case 'file_save': {
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

  tap: (instanceId: string) => {
    const state = get();
    const pet = state.pets[instanceId];
    if (!pet) return;
    const scores = addEmotion(pet.emotionScores, 'happy', 0.2);
    // Pick speech: emotion-specific phrases take priority
    const emotionList = EMOTION_PHRASES[pet.emotion];
    const list = emotionList || SPEECH_PHRASES[pet.task];
    const bubble = list[Math.floor(Math.random() * list.length)];
    set({ pets: updatePet(state.pets, instanceId, {
      emotionScores: scores,
      emotion: resolveEmotion(scores),
      speechBubble: bubble,
    }) });
    // Clear previous timer for this pet
    const prev = speechTimers.get(instanceId);
    if (prev) clearTimeout(prev);
    speechTimers.set(instanceId, setTimeout(() => {
      speechTimers.delete(instanceId);
      const s = usePetStore.getState();
      usePetStore.setState({ pets: updatePet(s.pets, instanceId, { speechBubble: null }) });
    }, 2000));
  },

  selectPet: (instanceId: string) => {
    set({ selectedPetId: instanceId });
  },

  setViewMode: (mode: 'single' | 'all') => {
    const state = get();
    // When switching to single and nothing selected, pick first
    if (mode === 'single' && !state.selectedPetId) {
      const ids = Object.keys(state.pets);
      set({ viewMode: mode, selectedPetId: ids[0] ?? null });
    } else {
      set({ viewMode: mode });
    }
  },
}));

// ── Module-level timers (survive component unmounts) ──

const timers: {
  task: ReturnType<typeof setInterval> | null;
  emotion: ReturnType<typeof setInterval> | null;
  walk: ReturnType<typeof setTimeout> | null;
} = { task: null, emotion: null, walk: null };

function startTimers() {
  if (timers.task) return; // already running

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
        // ── Task transitions ──
        if (elapsed >= SLEEP_TIMEOUT) {
          if (pet.task !== 'sleeping') newTask = 'sleeping';
        } else if (pet.claudeEndedAt > 0) {
          const sinceEnd = now - pet.claudeEndedAt;
          if (sinceEnd >= WAITING_TIMEOUT && elapsed >= IDLE_TIMEOUT && pet.task !== 'waiting') {
            newTask = 'waiting';
          } else if (elapsed >= IDLE_TIMEOUT && pet.task === 'working') {
            newTask = 'idle';
          }
        } else if (elapsed >= IDLE_TIMEOUT && pet.task === 'working') {
          newTask = 'idle';
        }

        // ── Loneliness: build sadness when inactive ──
        // After LONELY_START (1min): slow sadness (+0.015/2s → sad in ~60s)
        // After LONELY_DEEP (3min): faster sadness (+0.03/2s → sob in ~30s)
        if (elapsed >= LONELY_DEEP) {
          newScores = {
            happy: newScores.happy * 0.95,
            sad: Math.min(1, newScores.sad + 0.03),
          };
          scoresChanged = true;
        } else if (elapsed >= LONELY_START) {
          newScores = {
            happy: newScores.happy * 0.97,
            sad: Math.min(1, newScores.sad + 0.015),
          };
          scoresChanged = true;
        }
      }

      if (newTask !== pet.task || scoresChanged) {
        if (newTask !== pet.task) {
          console.log(`[PetStore] ${id}: ${pet.task} → ${newTask} (elapsed=${Math.round(elapsed/1000)}s, streaming=${pet.claudeStreaming}, endedAt=${pet.claudeEndedAt > 0 ? Math.round((now - pet.claudeEndedAt)/1000) + 's ago' : 'never'})`);
        }
        next[id] = {
          ...pet,
          task: newTask,
          ...(scoresChanged
            ? { emotionScores: newScores, emotion: resolveEmotion(newScores) }
            : {}),
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

      // Pick a random pet to walk
      const id = ids[Math.floor(Math.random() * ids.length)];
      const pet = pets[id];
      if (pet && pet.task !== 'sleeping' && pet.emotion !== 'sob') {
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
