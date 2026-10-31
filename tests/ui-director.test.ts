import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DirectorLink, boundRecentMessages, mergeRecent, sanitizeState } from '../src/components/directorClient';
import type { DirectorState } from '../src/shared/contracts';
import { directorStateSchema } from '../src/lib/director/schema';
import { toDirectorEvent } from '../src/lib/director/policy';
import { computeSnapshot, createWorld, makeDirectorState } from '../src/game/sim';

const state: DirectorState = {
  seed: 42,
  elapsed: 24,
  room: 'arrival',
  visitedRooms: ['arrival'],
  relays: 0,
  health: 75,
  flashlight: true,
  threat: 0.2,
  milestone: 'start',
  recentMessages: [],
};

function response(message: string): Response {
  return Response.json({
    source: 'fallback',
    event: { action: 'whisper', room: 'arrival', message, intensity: 0.2 },
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('engine health reaches server policy as a percentage while HUD stays fractional', () => {
  const world = createWorld(42);
  world.t = 24.5;
  const decision = { action: 'hunt' as const, message: 'Stay off the open channel.' };
  for (const [fraction, percentage, action] of [
    [1, 100, 'hunt'], [0.75, 75, 'hunt'], [0.31, 31, 'hunt'],
    [0.3, 30, 'whisper'], [0.2, 20, 'whisper'], [0, 0, 'whisper'],
  ] as const) {
    world.player.health = fraction;
    const telemetry = sanitizeState(makeDirectorState(world, 'room_enter'));
    const parsed = directorStateSchema.parse(telemetry);
    assert.equal(parsed.health, percentage);
    assert.equal(computeSnapshot(world).health, fraction);
    assert.equal(makeDirectorState(world, 'room_enter').elapsed, 24.5);
    assert.equal(toDirectorEvent(parsed, decision).action, action);
  }
});

test('client preserves health scale and honors backend radio bounds', () => {
  const sanitized = sanitizeState({
    ...state,
    recentMessages: Array.from({ length: 20 }, (_, i) => `${i}\u0000${'x'.repeat(200)}`),
  });
  assert.equal(sanitized?.health, 75);
  assert.equal(sanitized?.recentMessages.length, 8);
  for (const message of sanitized!.recentMessages) {
    assert.ok(message.length <= 160);
    assert.ok(!message.includes('\u0000'));
  }
  assert.equal(directorStateSchema.safeParse(sanitized).success, true);
  assert.equal(directorStateSchema.safeParse(sanitizeState({
    ...state, recentMessages: ['a\u202Eb\u0080c\u200Bd'],
  })).success, true);
  assert.equal(sanitizeState({ ...state, health: 500 })?.health, 100);
  assert.equal(boundRecentMessages([' hello\nworld ', 1])[0], 'hello world');
  assert.deepEqual(mergeRecent(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
});

test('reset starts the next request immediately and rejects previous-run responses', async (t) => {
  const requests: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = [];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) =>
    new Promise<Response>((resolve) => requests.push({ signal: init.signal!, resolve })),
  );
  const delivered: string[] = [];
  const link = new DirectorLink({ deliver: (event) => delivered.push(event.message), onLink: () => {} });
  t.after(() => link.destroy());
  link.newRun(0);
  link.submit(state, 0);
  link.newRun(1);
  link.submit(state, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.signal.aborted, true);

  requests[0]!.resolve(response('stale run'));
  await settle();
  // The old finally block must not clear the current run's single-flight lock.
  link.submit({ ...state, milestone: 'relay_restored', relays: 1 }, 1);
  assert.equal(requests.length, 2);
  requests[1]!.resolve(response('new run'));
  await settle();
  assert.deepEqual(delivered, ['new run']);
  assert.equal(requests.length, 3);
  requests[2]!.resolve(response('queued milestone'));
  await settle();
  assert.deepEqual(delivered, ['new run', 'queued milestone']);
});

test('the timeout covers body consumption and uses labelled fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  }));
  const delivered: string[] = [];
  const statuses: string[] = [];
  const link = new DirectorLink({ deliver: (_event, source) => delivered.push(source), onLink: (s) => statuses.push(s) });
  t.after(() => link.destroy());
  link.newRun(0);
  link.submit(state, 0);
  await settle();
  t.mock.timers.tick(9000);
  await settle();
  assert.deepEqual(delivered, ['fallback']);
  assert.deepEqual(statuses, ['idle', 'fallback']);
});

test('teardown rejects a late response and future milestones', async (t) => {
  let finish!: (response: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls += 1;
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const delivered: string[] = [];
  const link = new DirectorLink({ deliver: (event) => delivered.push(event.message), onLink: () => {} });
  link.newRun(0);
  link.submit(state, 0);
  link.destroy();
  finish(response('after teardown'));
  await settle();
  link.submit(state, 0);
  assert.equal(calls, 1);
  assert.deepEqual(delivered, []);
});

test('invalid model actions and intensity never reach the engine', async (t) => {
  const invalidEvents = [
    { action: 'teleport', message: 'invalid action', intensity: 0.2 },
    { action: 'hunt', message: 'invalid intensity', intensity: 20 },
    { action: 'whisper', message: 'invalid\u0000message', intensity: 0.2 },
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    source: 'live', event: { room: 'arrival', ...invalidEvents[calls++] },
  }));
  const sources: string[] = [];
  const actions: string[] = [];
  const link = new DirectorLink({
    deliver: (event, source) => { sources.push(source); actions.push(event.action); },
    onLink: () => {},
  });
  t.after(() => link.destroy());
  link.newRun(0);
  for (const _event of invalidEvents) {
    link.submit(state, 0);
    await settle();
  }
  assert.deepEqual(sources, ['fallback', 'fallback', 'fallback']);
  assert.deepEqual(actions, ['whisper', 'whisper', 'whisper']);
});
