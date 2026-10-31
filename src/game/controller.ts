/**
 * GameController — fixed-step loop, resize, snapshot/milestone plumbing.
 *
 * The engine is frames-of-truth: the controller only schedules the pure
 * simulation (stepWorld at exactly 1/60), forwards its queued sound/milestone
 * events to the UI callbacks, throttles snapshots to ≤10 Hz (phase flips emit
 * immediately), and keeps the canvas sized to its container (DPR capped at 2).
 */

import type { DirectorEvent, GameOptions, GameSnapshot, GameController as IGameController, Milestone, SoundCue } from '../shared/contracts';
import { InputController } from './input';
import { Renderer } from './render';
import { TUNE, applyDirectorEvent, computeSnapshot, createWorld, drainEvents, makeDirectorState, setPhase, stepWorld, worldChooseEnding, worldInteract, worldToggleFlashlight, type SimInput, type World } from './sim';

const TICK = TUNE.tick;
const SNAPSHOT_MS = 100; // 10 Hz ceiling

export interface DeadFrequencyGame extends IGameController {
  getThreat(): number;
}

export function createGame(canvas: HTMLCanvasElement, options: GameOptions): IGameController {
  const onSnapshot = options.onSnapshot;
  const onMilestone = options.onMilestone;
  const onSound = options.onSound;
  if (typeof onSnapshot !== 'function' || typeof onMilestone !== 'function' || typeof onSound !== 'function') {
    throw new TypeError('Dead Frequency: onSnapshot, onMilestone and onSound must be functions.');
  }

  const seed = Math.floor(Number(options.seed ?? 20261031)) >>> 0;
  let world: World = createWorld(seed);

  const renderer = new Renderer(canvas);
  const input = new InputController(canvas, {
    onEdge: (code) => {
      if (code === 'KeyE') controller.interact();
      else controller.toggleFlashlight();
    },
  });

  let rafId: number | null = null;
  let destroyed = false;
  let acc = 0;
  let lastTs = 0;
  let lastEmit = -Infinity;
  let lastPhase: GameSnapshot['phase'] | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const emit = (snap: GameSnapshot): void => {
    lastPhase = snap.phase;
    lastEmit = performance.now();
    try {
      onSnapshot(snap);
    } catch {
      // UI callbacks must never break the loop
    }
  };

  const resize = (): void => {
    if (destroyed) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w > 0 && h > 0) renderer.setCssSize(w, h);
  };

  const controller: IGameController = {
    start(): void {
      if (destroyed) return;
      if (world.phase !== 'ready') return;
      setPhase(world, 'playing');
      world.fired.start = true;
      try {
        onMilestone(makeDirectorState(world, 'start' satisfies Milestone));
      } catch {
        // A failed director callback must not prevent starting the run.
      }
      if (destroyed) return;
      emit(computeSnapshot(world));
    },
    pause(): void {
      if (destroyed) return;
      if (world.phase !== 'playing') return;
      setPhase(world, 'paused');
      input.clearHeld();
    },
    resume(): void {
      if (destroyed) return;
      if (world.phase !== 'paused') return;
      setPhase(world, 'playing');
    },
    reset(nextSeed?: number): void {
      if (destroyed) return;
      const s = nextSeed === undefined ? world.seed : Math.floor(Number(nextSeed)) >>> 0;
      world = createWorld(Number.isFinite(s) ? s : seed);
      renderer.resetCamera();
      input.clearHeld();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      input.detach();
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    },
    interact(): void {
      if (destroyed || world.phase !== 'playing') return;
      worldInteract(world);
    },
    toggleFlashlight(): void {
      if (destroyed || world.phase !== 'playing') return;
      worldToggleFlashlight(world);
    },
    chooseEnding(ending): void {
      if (destroyed) return;
      worldChooseEnding(world, ending);
    },
    applyDirectorEvent(event): void {
      if (destroyed) return;
      applyDirectorEvent(world, event);
    },
    setTouchInput(x: number, y: number, sprint: boolean): void {
      if (destroyed) return;
      input.setTouchInput(x, y, sprint);
    },
    getSnapshot(): GameSnapshot {
      return computeSnapshot(world);
    },
  };
  const controllerEx = controller as DeadFrequencyGame;
  controllerEx.getThreat = () => world.threat;

  const onWindowResize = (): void => resize();

  input.attach(() => world.phase);

  // initial size + observe the container the canvas lives in
  resize();
  if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(canvas);
  }

  const buildInput = (): SimInput => {
    const zero = { moveX: 0, moveY: 0, sprint: false, aimActive: false, aimX: 0, aimY: 0 };
    if (world.phase !== 'playing') return zero;
    const intent = input.moveIntent();
    const p = world.player;
    let aimActive = false;
    let aimX = 0;
    let aimY = 0;
    if (input.mouseFresh(2500)) {
      const wp = renderer.worldFromScreen(input.pointer.cssX, input.pointer.cssY);
      aimX = wp.x - p.x;
      aimY = wp.y - p.y;
      if (Math.abs(aimX) + Math.abs(aimY) > 0.4) aimActive = true;
    }
    return {
      moveX: Number.isFinite(intent.x) ? intent.x : 0,
      moveY: Number.isFinite(intent.y) ? intent.y : 0,
      sprint: intent.sprint === true,
      aimActive,
      aimX: aimActive ? aimX : 0,
      aimY: aimActive ? aimY : 0,
    };
  };

  const tick = (ts: number): void => {
    if (destroyed) return;
    rafId = requestAnimationFrame(tick);
    const raw = lastTs === 0 ? 0 : (ts - lastTs) / 1000;
    lastTs = ts;
    const dt = Math.min(0.25, Math.max(0, raw));

    // ---- fixed-step simulation ----
    if (world.phase === 'playing') {
      acc += dt;
      let steps = 0;
      while (acc >= TICK && steps < 6) {
        stepWorld(world, buildInput(), TICK);
        acc -= TICK;
        steps++;
      }
      if (acc > TICK * 2) acc = 0; // spiral-of-death guard
    }

    // Interactions can change phase before the next frame (choice/ending).
    // Drain their cues even when simulation time has stopped.
    const events = drainEvents(world);
    for (const ev of events) {
      if (destroyed) return;
      if (ev.type === 'sound') {
        try {
          onSound(ev.cue as SoundCue);
        } catch {
          /* UI owns audio; failures stay local */
        }
      } else {
        try {
          onMilestone(makeDirectorState(world, ev.milestone));
        } catch {
          /* see above */
        }
      }
    }
    if (destroyed) return;

    // ---- render (ambient scene in ready) ----
    renderer.render(world, {
      timeSec: ts / 1000,
      pointerCss: { x: input.pointer.cssX, y: input.pointer.cssY },
      pointerActive: input.pointer.active,
    });

    // ---- snapshot throttle ≤10 Hz, immediate on phase flips ----
    const snap = computeSnapshot(world);
    const now = lastTs;
    if (snap.phase !== lastPhase || now - lastEmit >= SNAPSHOT_MS) {
      emit(snap);
    }
  };

  rafId = requestAnimationFrame(tick);
  emit(computeSnapshot(world)); // boot snapshot so the UI can mount statefully

  return controllerEx;
}
