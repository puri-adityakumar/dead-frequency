import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGame } from '../src/game/controller';
import { Renderer } from '../src/game/render';
import type { World } from '../src/game/sim';
import type { SoundCue } from '../src/shared/contracts';

test('controller isolates start callbacks, drains ending audio, and cancels its frame', (t) => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  class Canvas extends EventTarget {
    clientWidth = 1280;
    clientHeight = 800;
    getContext() {
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      };
    }
  }
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Canvas() });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  globals('window', new EventTarget());
  globals('document', doc);
  globals('ResizeObserver', undefined);
  globals('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.set(++frameId, fn);
    return frameId;
  });
  globals('cancelAnimationFrame', (id: number) => frames.delete(id));
  const advance = (time: number) => {
    const [id, fn] = frames.entries().next().value!;
    frames.delete(id);
    fn(time);
  };
  let world!: World;
  t.mock.method(Renderer.prototype, 'render', (next: World) => { world = next; });
  t.mock.method(Renderer.prototype, 'setCssSize', () => {});
  const sounds: SoundCue[] = [];
  let milestones = 0;
  const controller = createGame(new Canvas() as unknown as HTMLCanvasElement, {
    onSnapshot() {},
    onSound: (cue) => sounds.push(cue),
    onMilestone() { milestones += 1; throw new Error('director unavailable'); },
  });
  t.after(() => controller.destroy());
  assert.doesNotThrow(() => controller.start());
  controller.start();
  assert.equal(milestones, 1);
  assert.equal(controller.getSnapshot().phase, 'playing');
  advance(100);
  world.phase = 'choice'; // Explicit pure-state setup for the terminal interaction.
  controller.chooseEnding('release');
  advance(120);
  assert.equal(controller.getSnapshot().phase, 'won');
  assert.ok(sounds.includes('ending'), 'Ending audio dispatches even outside the playing phase');
  assert.equal(frames.size, 1);
  controller.destroy();
  controller.destroy();
  assert.equal(frames.size, 0);
});
