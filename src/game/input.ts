/**
 * Desktop input — keyboard (WASD/arrows, Shift sprint, E interact, F flashlight)
 * and pointer aim. Pure plumbing: it reports intent, the controller decides.
 *
 * Guarantees asked for by the contract:
 *  - keys held in a form control (input/textarea/select/contentEditable) are
 *    never consumed or intercepted;
 *  - movement intent is zeroed whenever the page is inactive (blur/hidden);
 *  - engine never registers listeners it forgets to remove (detach is total).
 */

import type { World } from './sim';

export interface PointerState {
  cssX: number;
  cssY: number;
  active: boolean;
  lastMove: number;
}

const TRACK_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

const CONSUME_CODES = new Set<string>([...TRACK_CODES, 'KeyE', 'KeyF']);

export interface InputHooks {
  onEdge(code: 'KeyE' | 'KeyF'): void;
}

export class InputController {
  private canvas: HTMLCanvasElement;
  private hooks: InputHooks;
  private held = new Set<string>();
  private touch = { x: 0, y: 0, sprint: false };
  pointer: PointerState = { cssX: 0, cssY: 0, active: false, lastMove: 0 };
  private detached = false;
  private bound: Array<[EventTarget, string, EventListener]> = [];

  constructor(canvas: HTMLCanvasElement, hooks: InputHooks) {
    this.canvas = canvas;
    this.hooks = hooks;
  }

  attach(phaseGetter: () => World['phase']): void {
    const win = typeof window !== 'undefined' ? window : null;
    const doc = typeof document !== 'undefined' ? document : null;
    if (!win || !doc) return;

    const onKeyDown = (ev: Event): void => {
      const e = ev as KeyboardEvent;
      if (this.formTarget(e)) return;
      const phase = phaseGetter();
      if (phase !== 'playing') {
        // Not consuming anything while inactive: browser/native behaviour intact.
        if (e.code === 'KeyE' || e.code === 'KeyF') this.held.delete(e.code);
        return;
      }
      if (e.repeat) return;
      if (e.code === 'KeyE') {
        e.preventDefault();
        this.hooks.onEdge('KeyE');
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        this.hooks.onEdge('KeyF');
        return;
      }
      if (CONSUME_CODES.has(e.code)) {
        if (TRACK_CODES.has(e.code)) this.held.add(e.code);
        if (e.code.startsWith('Arrow')) e.preventDefault();
      }
    };
    const onKeyUp = (ev: Event): void => {
      const e = ev as KeyboardEvent;
      this.held.delete(e.code);
    };
    // Even keyups coming from a form control are safe: removal is idempotent.
    const onBlur = (): void => {
      this.clearHeld();
    };
    const onVisibility = (): void => {
      if (typeof document !== 'undefined' && document.hidden) this.clearHeld();
    };
    const onPointerMove = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (e.pointerType === 'touch') return; // touch aims through setTouchInput
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.cssX = e.clientX - rect.left;
      this.pointer.cssY = e.clientY - rect.top;
      this.pointer.active = true;
      this.pointer.lastMove = performance.now();
    };
    const onPointerLeave = (): void => {
      this.pointer.active = false;
    };
    const onContext = (ev: Event): void => {
      ev.preventDefault();
    };

    win.addEventListener('keydown', onKeyDown, { passive: false });
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointerleave', onPointerLeave);
    this.canvas.addEventListener('contextmenu', onContext);
    this.bound = [
      [win, 'keydown', onKeyDown],
      [win, 'keyup', onKeyUp],
      [win, 'blur', onBlur],
      [doc, 'visibilitychange', onVisibility],
      [this.canvas, 'pointermove', onPointerMove],
      [this.canvas, 'pointerleave', onPointerLeave],
      [this.canvas, 'contextmenu', onContext],
    ];
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    for (const [target, type, fn] of this.bound) {
      target.removeEventListener(type, fn);
    }
    this.bound = [];
    this.clearHeld();
  }

  setTouchInput(x: number, y: number, sprint: boolean): void {
    const len = Math.hypot(x, y);
    if (len > 1) {
      this.touch = { x: x / len, y: y / len, sprint };
    } else {
      this.touch = { x, y, sprint };
    }
  }

  clearTouch(): void {
    this.touch = { x: 0, y: 0, sprint: false };
  }

  clearHeld(): void {
    this.held.clear();
    this.clearTouch();
    this.pointer.active = false;
  }

  private formTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
    if (t.isContentEditable) return true;
    return false;
  }

  moveIntent(): { x: number; y: number; sprint: boolean } {
    if (this.detached) return { x: 0, y: 0, sprint: false };
    const touchOn = Math.hypot(this.touch.x, this.touch.y) > 0.22;
    if (touchOn) {
      return { x: this.touch.x, y: this.touch.y, sprint: this.touch.sprint };
    }
    let x = 0;
    let y = 0;
    if (this.held.has('KeyW') || this.held.has('ArrowUp')) y -= 1;
    if (this.held.has('KeyS') || this.held.has('ArrowDown')) y += 1;
    if (this.held.has('KeyA') || this.held.has('ArrowLeft')) x -= 1;
    if (this.held.has('KeyD') || this.held.has('ArrowRight')) x += 1;
    const sprint = this.held.has('ShiftLeft') || this.held.has('ShiftRight');
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y, sprint };
  }

  mouseFresh(windowMs: number): boolean {
    return this.pointer.active && performance.now() - this.pointer.lastMove <= windowMs;
  }
}
