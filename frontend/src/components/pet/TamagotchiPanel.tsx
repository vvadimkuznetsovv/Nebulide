import { useState, useRef, useEffect, useCallback } from 'react';
import { usePetStore, getSpriteSheet, TASK_CONFIGS, EMOTION_SWAY, type PetTask, type PetEmotion } from '../../store/petStore';
import { getTerminalLabel, useTerminalRegistryVersion } from '../../utils/terminalRegistry';

// ── Animation constants ──

const FRAME_SIZE = 64;
const SWAY_DURATION = 2.0; // seconds
const WALK_LERP_SPEED = 0.02; // per frame

const TASK_LABELS: Record<PetTask, string> = {
  idle: 'Chilling',
  working: 'Working',
  sleeping: 'Sleeping',
  compacting: 'Compacting',
  waiting: 'Waiting',
};

const EMOTION_ICONS: Record<PetEmotion, string> = {
  happy: '\u2728',
  neutral: '\u2022',
  sad: '\ud83d\udca7',
  sob: '\ud83d\ude22',
};

const EMOTION_DOT_COLORS: Record<PetEmotion, string> = {
  happy: '#4ade80',
  neutral: '#6b7280',
  sad: '#60a5fa',
  sob: '#f87171',
};

function AnimatedDots() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const id = setInterval(() => setDots((d) => d.length >= 3 ? '' : d + '.'), 500);
    return () => clearInterval(id);
  }, []);
  return <>{dots}</>;
}

// ── Sprite refs for rAF loop (module-level, survives remounts) ──

interface SpriteRefs {
  sprite: HTMLDivElement;
  pet: HTMLDivElement;
  walkX: number;
  walkTarget: number;
  walkDir: 1 | -1;
  frameIndex: number;
  lastFrameTime: number;
}

const spriteRefsMap = new Map<string, SpriteRefs>();

// ── Component ──

export default function TamagotchiPanel() {
  const pets = usePetStore((s) => s.pets);
  const selectedPetId = usePetStore((s) => s.selectedPetId);
  const viewMode = usePetStore((s) => s.viewMode);
  const selectPet = usePetStore((s) => s.selectPet);
  const setViewMode = usePetStore((s) => s.setViewMode);
  const tapPet = usePetStore((s) => s.tap);

  // Subscribe to registry version for re-renders when terminal labels change
  useTerminalRegistryVersion();

  const sceneRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const startTime = useRef(Date.now());

  const petIds = Object.keys(pets);
  const hasPets = petIds.length > 0;

  // Determine which pets to render in the scene
  const visiblePetIds = viewMode === 'single' && selectedPetId && pets[selectedPetId]
    ? [selectedPetId]
    : petIds;

  // Sync walk refs from store subscription
  useEffect(() => {
    const unsub = usePetStore.subscribe((s) => {
      for (const [id, pet] of Object.entries(s.pets)) {
        const refs = spriteRefsMap.get(id);
        if (refs) {
          refs.walkTarget = pet.walkTarget;
          refs.walkDir = pet.walkDirection;
        }
      }
    });
    return unsub;
  }, []);

  // Main animation loop — iterates all visible sprites
  const animate = useCallback((timestamp: number) => {
    rafRef.current = requestAnimationFrame(animate);

    const scene = sceneRef.current;
    if (!scene) return;

    const sceneW = scene.offsetWidth;
    const store = usePetStore.getState();
    const allIds = Object.keys(store.pets);
    const visible = store.viewMode === 'single' && store.selectedPetId && store.pets[store.selectedPetId]
      ? [store.selectedPetId]
      : allIds;
    const petCount = visible.length;

    const t = (timestamp - startTime.current) / 1000;

    for (let i = 0; i < visible.length; i++) {
      const id = visible[i];
      const pet = store.pets[id];
      const refs = spriteRefsMap.get(id);
      if (!pet || !refs) continue;

      const cfg = TASK_CONFIGS[pet.task];
      const sway = EMOTION_SWAY[pet.emotion];

      // Frame cycling
      const frameInterval = 1000 / cfg.fps;
      if (timestamp - refs.lastFrameTime >= frameInterval) {
        refs.frameIndex = (refs.frameIndex + 1) % cfg.frames;
        refs.lastFrameTime = timestamp;
        refs.sprite.style.backgroundPositionX = `${-refs.frameIndex * FRAME_SIZE}px`;
      }

      // Bob
      const bobPhase = (t % cfg.bobDuration) / cfg.bobDuration;
      const bobEase = 0.5 - 0.5 * Math.cos(bobPhase * Math.PI * 2);
      const bobY = bobEase * cfg.bobAmplitude;

      // Sway
      const swayPhase = (t % SWAY_DURATION) / SWAY_DURATION;
      const swayAngle = Math.sin(swayPhase * Math.PI * 2) * sway;

      // Tremble (sob only)
      let trembleX = 0;
      if (pet.emotion === 'sob') {
        trembleX = Math.sin(t * Math.PI * 4) * 0.3;
      }

      // Walk lerp
      const diff = refs.walkTarget - refs.walkX;
      if (Math.abs(diff) > 0.005) {
        refs.walkX += diff * WALK_LERP_SPEED;
      }

      // In all-mode, constrain walk to pet's segment
      let walkNorm = refs.walkX;
      if (petCount > 1) {
        const segStart = i / petCount;
        const segEnd = (i + 1) / petCount;
        walkNorm = segStart + refs.walkX * (segEnd - segStart);
      }

      const margin = FRAME_SIZE + 10;
      const walkPx = margin + walkNorm * (sceneW - margin * 2);

      refs.pet.style.transform = `translate(${walkPx + trembleX}px, ${-bobY}px) rotate(${swayAngle}deg)`;
      refs.pet.style.transformOrigin = 'center bottom';

      // Flip sprite based on walk direction
      refs.sprite.style.transform = refs.walkDir < 0 ? 'scaleX(-1)' : '';
    }
  }, []);

  // Start/stop rAF
  useEffect(() => {
    startTime.current = Date.now();
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [animate]);

  // Ref callback for pet sprites
  const setPetRef = useCallback((id: string, petEl: HTMLDivElement | null, spriteEl: HTMLDivElement | null) => {
    if (petEl && spriteEl) {
      const pet = usePetStore.getState().pets[id];
      if (!spriteRefsMap.has(id)) {
        spriteRefsMap.set(id, {
          sprite: spriteEl,
          pet: petEl,
          walkX: pet?.walkX ?? 0.5,
          walkTarget: pet?.walkTarget ?? 0.5,
          walkDir: pet?.walkDirection ?? 1,
          frameIndex: 0,
          lastFrameTime: 0,
        });
      } else {
        const refs = spriteRefsMap.get(id)!;
        refs.sprite = spriteEl;
        refs.pet = petEl;
      }
    }
  }, []);

  // Clean up stale sprite refs
  useEffect(() => {
    for (const id of spriteRefsMap.keys()) {
      if (!pets[id]) spriteRefsMap.delete(id);
    }
  }, [pets]);

  const handleTap = useCallback((id: string) => {
    tapPet(id);
    if (viewMode === 'all') selectPet(id);
    // Bounce animation
    const refs = spriteRefsMap.get(id);
    if (refs?.pet) {
      refs.pet.animate([
        { transform: refs.pet.style.transform },
        { transform: refs.pet.style.transform.replace(/\)/, ') scale(1.15)'), offset: 0.3 },
        { transform: refs.pet.style.transform },
      ], { duration: 300, easing: 'ease-out' });
    }
  }, [tapPet, selectPet, viewMode]);

  // Selected pet for status bar
  const selectedPet = selectedPetId ? pets[selectedPetId] : null;
  const statusPet = selectedPet ?? (petIds.length > 0 ? pets[petIds[0]] : null);
  const statusId = selectedPetId && pets[selectedPetId] ? selectedPetId : petIds[0] ?? null;

  return (
    <div className="tamagotchi-panel">
      {/* Toolbar — pet selector + view mode */}
      {hasPets && (
        <div className="tamagotchi-toolbar">
          <div className="tamagotchi-toolbar-pets">
            {petIds.map((id) => {
              const pet = pets[id];
              const label = getTerminalLabel(id);
              const shortLabel = label.replace('Terminal-', 'T-');
              return (
                <button
                  key={id}
                  className={`tamagotchi-pet-btn${id === selectedPetId ? ' active' : ''}`}
                  onClick={() => selectPet(id)}
                  title={label}
                >
                  <span
                    className="tamagotchi-pet-btn-dot"
                    style={{ background: EMOTION_DOT_COLORS[pet.emotion] }}
                  />
                  {shortLabel}
                </button>
              );
            })}
          </div>
          <button
            className="tamagotchi-view-toggle"
            onClick={() => setViewMode(viewMode === 'single' ? 'all' : 'single')}
            title={viewMode === 'single' ? 'Show all pets' : 'Show selected pet'}
          >
            {viewMode === 'single' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Scene */}
      <div className="tamagotchi-scene" ref={sceneRef}>
        <div className="tamagotchi-grass" />

        {!hasPets && (
          <div className="tamagotchi-empty">Open a terminal</div>
        )}

        {visiblePetIds.map((id) => {
          const pet = pets[id];
          if (!pet) return null;
          const spriteUrl = getSpriteSheet(pet.task, pet.emotion);
          const config = TASK_CONFIGS[pet.task];
          const label = getTerminalLabel(id);
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) {
                  const spriteEl = el.querySelector('.tamagotchi-sprite') as HTMLDivElement | null;
                  setPetRef(id, el, spriteEl);
                }
              }}
              className={`tamagotchi-pet${id === selectedPetId ? ' selected' : ''}`}
              onClick={() => handleTap(id)}
              style={{ cursor: 'pointer' }}
            >
              {/* Label above pet */}
              {visiblePetIds.length > 1 && (
                <div className="tamagotchi-label">{label.replace('Terminal-', 'T-')}</div>
              )}

              <div
                className="tamagotchi-sprite"
                style={{
                  backgroundImage: `url(${spriteUrl})`,
                  backgroundSize: `${config.frames * FRAME_SIZE}px ${FRAME_SIZE}px`,
                }}
              />

              {/* Speech bubble */}
              {pet.speechBubble && (
                <div className="tamagotchi-speech">
                  {pet.speechBubble}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Status bar */}
      <div className="tamagotchi-status">
        {statusPet && statusId ? (
          <>
            <span className="tamagotchi-status-emotion">{EMOTION_ICONS[statusPet.emotion]}</span>
            <span className="tamagotchi-status-name">{getTerminalLabel(statusId)}</span>
            <span className="tamagotchi-status-task">
              {TASK_LABELS[statusPet.task]}
              {statusPet.task === 'working' && <AnimatedDots />}
            </span>
          </>
        ) : (
          <span className="tamagotchi-status-task">No pets</span>
        )}
      </div>
    </div>
  );
}
