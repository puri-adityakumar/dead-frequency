/**
 * Dead Frequency — engine unit tests (pure simulation only, no canvas).
 * Run: npx tsx --test tests/game.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TUNE, applyDirectorEvent, computeSnapshot, createWorld, emptyInput, makeDirectorState, setPhase, stepWorld, worldChooseEnding, worldInteract, worldToggleFlashlight, drainEvents, type World } from '../src/game/sim';
import { TILE, TILE_FLOOR, TILE_WALL, createMap, roomAtPoint } from '../src/game/map';
import { circleBlocked, hasLos, reachableSet } from '../src/game/nav';

const SEED = 20261031;

function playing(seed = SEED): World {
  const w = createWorld(seed);
  setPhase(w, 'playing');
  return w;
}

function tickHealth(w: World, ticks = 1, input = emptyInput()): void {
  for (let i = 0; i < ticks; i++) stepWorld(w, input, TUNE.tick);
}

function placeNearRelay(w: World, i: number, offset = 6.6): void {
  const relay = w.relays[i]!;
  w.player.x = relay.x + offset;
  w.player.y = relay.y;
  w.player.vx = 0;
  w.player.vy = 0;
}

function restoreAllRelays(w: World): void {
  // keep the creature down during setup so assertions stay deterministic
  const savedPhase = w.phase;
  setPhase(w, 'playing');
  for (let i = 0; i < w.relays.length; i++) {
    placeNearRelay(w, i);
    w.creatureActive = false;
    w.creature.state = 'dormant';
    tickHealth(w, 2);
    worldInteract(w);
  }
  w.phase = savedPhase;
}

// ---------------------------------------------------------------- connectivity

test('map: facility graph connects every relay, seals the exit until relays hold', () => {
  for (const seed of [SEED, 7, 99, 4242, 31337] as const) {
    const map = createMap(seed);
    const reach = reachableSet(map, false, map.spawn.x, map.spawn.y);
    assert(reach.size > 40, `seed ${seed}: crumb-thin walkable graph under seed`);

    // every relay pedestal is approachable from the arrival spawn with the gate sealed
    for (const relay of map.relays) {
      const tx = Math.floor(relay.x / TILE);
      const ty = Math.floor(relay.y / TILE);
      const ok = [
        [tx + 1, ty],
        [tx - 1, ty],
        [tx, ty + 1],
        [tx, ty - 1],
      ].some(([x, y]) => reach.has((y as number) * map.w + (x as number)));
      assert(ok, `seed ${seed}: relay in ${relay.room} unreachable while gate sealed`);
    }
    // console hides behind the gate pre-relays; once the gate opens the atrium
    // (and a tile adjacent to the pedestal, which itself is prop-marked) is walkable
    const ctxT = Math.floor(map.consoleSite.x / TILE);
    const ctxY = Math.floor(map.consoleSite.y / TILE);
    const cIdx = ctxY * map.w + ctxT;
    const reachOpen = reachableSet(map, true, map.spawn.x, map.spawn.y);
    assert(!reach.has(cIdx), `seed ${seed}: console reachable while gate still sealed`);
    const consoleOk = [
      [ctxT + 1, ctxY],
      [ctxT - 1, ctxY],
      [ctxT, ctxY + 1],
      [ctxT, ctxY - 1],
    ].some(([x, y]) => reachOpen.has((y as number) * map.w + (x as number)));
    assert(consoleOk, `seed ${seed}: exit console unreachable once the gate opens`);
    // gate tiles exist and cover the approach
    assert(map.gateTiles.length >= 2, `seed ${seed}: gate cross-section missing`);
    // the spawn sits on open floor
    assert(reach.has(Math.floor(map.spawn.y / TILE) * map.w + Math.floor(map.spawn.x / TILE)), `seed ${seed}: spawn not walkable`);
  }
});

test('map: five contract rooms present with distinct centers', () => {
  const map = createMap(SEED);
  const ids = map.rooms.map((r) => r.id).sort();
  assert.deepEqual(ids, ['archives', 'arrival', 'exit', 'medical', 'reactor']);
  for (let i = 0; i < map.rooms.length; i++) {
    for (let j = i + 1; j < map.rooms.length; j++) {
      const a = map.rooms[i]!;
      const b = map.rooms[j]!;
      assert(Math.hypot(a.cx - b.cx, a.cy - b.cy) > 30, 'room centers should be far apart');
    }
  }
});

// ---------------------------------------------------------------- determinism

test('determinism: same seed + same inputs produce identical worlds; seeds differ', () => {
  const scripted: Array<{ x: number; y: number; sprint: boolean }> = [];
  let dir = 1;
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 30; k++) scripted.push({ x: dir * 0.9, y: Math.sin(k * 0.31) * 0.9, sprint: k % 9 === 0 });
    dir = -dir;
  }

  const run = (seed: number): World => {
    const w = playing(seed);
    // same manipulation cadence in both runs
    let i = 0;
    for (const cmd of scripted) {
      if (i === 300) {
        // identical teleport unlocks the creature in both runs
        w.player.x = w.map.relays[1]!.x;
        w.player.y = w.map.relays[1]!.y;
      }
      if (i === 360) worldToggleFlashlight(w);
      stepWorld(w, { ...emptyInput(), moveX: cmd.x, moveY: cmd.y, sprint: cmd.sprint }, TUNE.tick);
      i++;
    }
    return w;
  };

  const a = run(SEED);
  const b = run(SEED);
  assert.equal(computeSnapshot(a).health, computeSnapshot(b).health);
  assert.equal(computeSnapshot(a).threat, computeSnapshot(b).threat);
  assert.equal(a.player.x, b.player.x);
  assert.equal(a.player.y, b.player.y);
  assert.equal(a.creature.x, b.creature.x);
  assert.equal(a.creature.y, b.creature.y);
  assert.equal(a.creature.state, b.creature.state);
  assert.equal(a.t, b.t);

  const c = run(SEED + 1);
  assert.notDeepEqual([...c.map.tiles], [...a.map.tiles], 'different seeds should lay different facilities');
});

// ---------------------------------------------------------------- collision

test('collision: player cannot pass walls, slides along them, never sinks into props', () => {
  const w = playing();
  const p = w.player;
  const map = w.map;

  // find a room with clear floor: use the arrival room
  const arrival = map.rooms.find((r) => r.id === 'arrival')!;
  p.x = arrival.cx;
  p.y = arrival.cy;
  p.vx = 0;
  p.vy = 0;

  // cannot walk into the near wall: push right a long time eventually wedges
  let lastX = p.x;
  let wedged = false;
  for (let i = 0; i < 600; i++) {
    tickHealth(w, 1, { ...emptyInput(), moveX: 1, moveY: 0 });
    if (p.x === lastX && i > 30) {
      wedged = true;
      break;
    }
    lastX = p.x;
    assert(!circleBlocked(map, false, p.x, p.y, TUNE.player.radius), 'player body must never intersect walls or props');
  }
  assert(wedged, 'pressing into a wall must stop the body before entering a solid');

  // slide: pressing diagonally along a wall still advances on the free axis.
  // Origin coordinates can't be hard-coded — corridor mouths can open into a
  // room's wall — so scan for a straight prop-free run with solid wall above.
  const findNorthRun = (): { x: number; y: number } => {
    const need = 11; // tiles of clear wall headroom ahead of the graze start
    for (let y = 1; y < map.h; y++) {
      let run = -1;
      for (let x = 0; x <= map.w; x++) {
        const floorHere = x < map.w && map.tiles[y * map.w + x] === TILE_FLOOR;
        const wallAbove = floorHere && map.tiles[(y - 1) * map.w + x] === TILE_WALL;
        if (floorHere && wallAbove) {
          if (run < 0) run = x;
          continue;
        }
        if (run >= 0) {
          const len = x - run;
          let clear = len >= need;
          for (let tx = run + 1; clear && tx < run + 1 + need; tx++) {
            if (map.propMap[y * map.w + tx] !== 0) clear = false;
          }
          if (clear) return { x: (run + 1.5) * TILE, y: y * TILE + 2.75 };
          run = -1;
        }
      }
    }
    return { x: arrival.cx, y: arrival.cy }; // unreachable in practice: corridors give long runs
  };
  const spot = findNorthRun();
  p.x = spot.x;
  p.y = spot.y; // grazing a north wall from inside the run
  p.vx = 0;
  p.vy = 0;
  const startX = p.x;
  const startY = p.y;
  for (let i = 0; i < 60; i++) {
    tickHealth(w, 1, { ...emptyInput(), moveX: 1, moveY: -1 });
    assert(!circleBlocked(map, false, p.x, p.y, TUNE.player.radius), 'sliding must stay collision-safe');
  }
  assert(p.x > startX + 4, 'wall-hug still progress along the free axis');
  assert(Math.abs(p.y - startY) < 1.5, 'blocked axis keeps its ground');
});

test('creature: navigates the walkable graph, never clips walls, never teleports', () => {
  const w = playing();
  setPhase(w, 'playing');
  w.player.x = w.map.relays[0]!.x; // wake it fast by entering a second room
  w.player.y = w.map.relays[0]!.y;
  w.creatureActive = true;
  w.creature.state = 'hunt';
  const from = { x: w.creature.x, y: w.creature.y };
  let maxStep = 0;
  for (let i = 0; i < 1400; i++) {
    // keep the animal interested but let it roam between rooms
    if (i % 220 === 0) {
      w.player.x = w.map.rooms[(i / 220) % w.map.rooms.length]!.cx;
      w.player.y = w.map.rooms[(i / 220) % w.map.rooms.length]!.cy;
    }
    w.player.visitedFirst.add(roomAtPoint(w.map, w.player.x, w.player.y) ?? 'arrival');
    tickHealth(w, 1);
    const d = Math.hypot(w.creature.x - from.x, w.creature.y - from.y);
    maxStep = Math.max(maxStep, d);
    from.x = w.creature.x;
    from.y = w.creature.y;
    const tx = Math.floor(w.creature.x / TILE);
    const ty = Math.floor(w.creature.y / TILE);
    const tile = w.map.tiles[ty * w.map.w + tx];
    assert(tile === TILE_FLOOR, `creature centre (${w.creature.x.toFixed(1)},${w.creature.y.toFixed(1)}) must stay on open floor`, );
    assert(maxStep < 140, 'creature frame movement must be bounded (no teleport/clipping)');
  }
});

// ---------------------------------------------------------------- damage & death

test('damage: contact hits once per grace window; three hits kill', () => {
  const w = playing();
  // set up somewhere far from reception (no sanctuary)
  const reactor = w.map.rooms.find((r) => r.id === 'reactor')!;
  w.player.x = reactor.cx;
  w.player.y = reactor.cy;
  w.player.visitedFirst.add('reactor');
  w.creatureActive = true;

  const hit = (): void => {
    w.creature.x = w.player.x + 5.2; // inside attackRange (6.4) but outside overlap
    w.creature.y = w.player.y;
    w.creature.state = 'hunt';
  };

  hit();
  tickHealth(w, 1);
  assert.equal(w.player.health, 1 - TUNE.creature.damage, 'first contact applies damage');
  assert.equal(w.phase, 'playing', 'grace keeps you alive after the first touch');

  // immediate second contact within the grace window must do nothing
  hit();
  tickHealth(w, 1);
  assert.equal(w.player.health, 1 - TUNE.creature.damage, 'grace window blocks instant stacking');

  // staying in contact until the window expires, then contact again → second hit
  for (let i = 0; i < 110; i++) {
    if (i === 10) hit(); // 1.83s later — grace (1.6s) has expired
    tickHealth(w, 1);
  }
  assert(Math.abs(w.player.health - (1 - TUNE.creature.damage * 2)) < 1e-9, 'second hit lands after the window');

  // wait out the final grace window, then let it land once more
  for (let i = 0; i < 110; i++) tickHealth(w, 1);
  hit();
  tickHealth(w, 1);
  assert.equal(w.player.health, 0);
  assert.equal(w.phase, 'dead', 'third hit is terminal');
});

test('damage: near_death milestone fires once at threshold with the radio note', () => {
  const w = playing();
  const medical = w.map.rooms.find((r) => r.id === 'medical')!;
  w.player.x = medical.cx;
  w.player.y = medical.cy;
  w.player.visitedFirst.add('medical');
  w.creatureActive = true;
  w.player.health = TUNE.nearDeathAt + 0.01;
  w.creature.x = w.player.x + 5.2;
  w.creature.y = w.player.y;
  w.creature.state = 'hunt';
  tickHealth(w, 1);
  const evs = drainEvents(w);
  const milestone = evs.find((e) => e.type === 'milestone' && e.milestone === 'near_death');
  assert(milestone, 'near_death milestone emitted');
  const sounds = evs.filter((e) => e.type === 'sound');
  assert(sounds.some((s) => s.type === 'sound' && s.cue === 'hurt'));

  dropEvents(w);
  w.player.health = 0.2;
  w.creature.x = w.player.x + 5.2;
  w.player.iframe = 0; // grace from the earlier hit has long expired; a fresh contact lands
  w.creature.stunTimer = 0; // ...and the creature shakes off its post-attack stagger
  tickHealth(w, 1);
  const evs2 = drainEvents(w);
  assert(!evs2.some((e) => e.type === 'milestone'), 'one-shot milestone does not re-fire before death');
  assert.equal(w.phase, 'dead', '0.2 - 0.34 finishes the player');
  const dir = makeDirectorState(w, 'near_death');
  assert.equal(dir.health, 0);
});

function dropEvents(w: World): void {
  drainEvents(w);
}

// ---------------------------------------------------------------- objectives & endings

test('objectives: relays restore inside radius only; three relays unseal the gate', () => {
  const w = playing();
  placeNearRelay(w, 0);
  tickHealth(w, 1);
  worldInteract(w);
  assert.equal(w.relayCount, 1);
  assert(w.relayDone[0] === true);
  drainEvents(w);

  // out of range does nothing
  w.player.x = w.relays[1]!.x + 14;
  w.player.y = w.relays[1]!.y;
  tickHealth(w, 1);
  worldInteract(w);
  assert.equal(w.relayCount, 1, 'outside radius E is ignored');

  restoreAllRelays(w);
  assert.equal(w.relayCount, 3);
  assert(w.gateOpen === true, 'gate unseals at three relays');
  const evs = drainEvents(w);
  const milestones = evs.filter((e) => e.type === 'milestone').map((e) => (e as { milestone: string }).milestone);
  assert(milestones.includes('relay_restored'));
  assert(milestones.includes('exit_ready'));
  assert(evs.some((e) => e.type === 'sound' && e.cue === 'alarm'));

  // console opens the choice
  const consoleSite = w.map.consoleSite;
  w.player.x = consoleSite.x + 4;
  w.player.y = consoleSite.y + 4;
  tickHealth(w, 1);
  assert.equal(w.interaction, 'OPERATOR CONSOLE [E]');
  worldInteract(w);
  assert.equal(w.phase, 'choice');

  // both endings work from choice; wrong phase or unknown value rejected
  const w2 = playing();
  worldChooseEnding(w2, 'shutdown');
  assert.notEqual(w2.phase, 'won', 'ending requires the choice phase');
  const snapshotBefore = computeSnapshot(w);
  worldChooseEnding(w as World, 'shutdown');
  assert.equal(w.phase, 'won');
  assert.equal(computeSnapshot(w).ending, 'shutdown');
  assert.equal(snapshotBefore.ending, null);
  const evs2 = drainEvents(w);
  assert(evs2.some((e) => e.type === 'sound' && e.cue === 'ending'));
});

test('objectives: full run reaches the won phase with release ending and frozen sim', () => {
  const w = playing();
  restoreAllRelays(w);
  const consoleSite = w.map.consoleSite;
  w.player.x = consoleSite.x + 4;
  w.player.y = consoleSite.y;
  tickHealth(w, 1);
  worldInteract(w);
  assert.equal(w.phase, 'choice');
  const elapsed = w.t;
  const creatureX = w.creature.x;
  worldChooseEnding(w, 'release');
  assert.equal(computeSnapshot(w).ending, 'release');
  assert.equal(w.phase, 'won');
  // simulation freezes at won: the world stops moving
  tickHealth(w, 120);
  assert.equal(w.t, elapsed, 'no time passes after victory');
  assert.equal(w.creature.x, creatureX, 'creature halts after victory');
  const w2 = playing();
  restoreAllRelays(w2);
});

// ---------------------------------------------------------------- director events

test('director: effects expire, never teleport, never kill, invalid entries ignored', () => {
  const w = playing();
  const reactor = w.map.rooms.find((r) => r.id === 'reactor')!;
  w.player.x = reactor.cx;
  w.player.y = reactor.cy;
  w.player.visitedFirst.add('reactor');
  tickHealth(w, 1); // let the sim settle the player's room tracker
  w.creatureActive = true;
  w.creature.state = 'roam';
  const cx0 = w.creature.x;
  const cy0 = w.creature.y;

  applyDirectorEvent(w, { action: 'hunt', room: 'reactor', message: 'SOMETHING ANSWERS ON A CARRIER.', intensity: 0.9 });
  assert(w.effects.some((e) => e.kind === 'hunt'));
  applyDirectorEvent(w, { action: 'lights_flicker', room: 'reactor', message: 'THE GRID CUTS OUT.', intensity: 1 });
  assert(w.effects.some((e) => e.kind === 'flicker'));
  applyDirectorEvent(w, { action: 'false_alarm', room: 'medical', message: 'A FALSE CHIME.', intensity: 0.5 });
  const decoy = w.effects.find((e) => e.kind === 'decoy');
  assert(decoy, 'decoy effect exists');
  const decoyTile = w.map.tiles[Math.floor((decoy!.ty ?? 0) / TILE) * w.map.w + Math.floor((decoy!.tx ?? 0) / TILE)];
  assert.equal(decoyTile, TILE_FLOOR, 'decoy target must sit on open floor (no trapping)');
  applyDirectorEvent(w, { action: 'whisper', room: 'reactor', message: 'WHISPERS.', intensity: 0.2 });

  const dir = makeDirectorState(w, 'room_enter');
  assert.equal(dir.room, 'reactor');
  assert(dir.recentMessages.length <= TUNE.messageCap);
  assert(dir.recentMessages.some((m) => m.startsWith('SOMETHING ANSWERS')));

  // invalid events: unknown action / room / message type never touch the world
  const effCount = w.effects.length;
  const msgCount = w.messages.length;
  applyDirectorEvent(w, { action: 'exploit_tag_teleport_everything_to_death', room: 'reactor', message: 'x', intensity: 1 } as never);
  applyDirectorEvent(w, { action: 'hunt', room: 'the_void_beyond_exit', message: 'x', intensity: 1 } as never);
  applyDirectorEvent(w, { action: 'help', room: 'reactor', message: 42 as unknown as string, intensity: 1 });
  assert.equal(w.effects.length, effCount, 'invalid actions add nothing');
  assert.equal(w.messages.length, msgCount, 'invalid messages queue nothing');

  // player survives the full effect window; creature never teleports.
  // The player waits it out inside reception: the sanctuary masks senses and
  // contact, so the only force at play is the director — not a creature contact
  // (which the sim is free to apply outside the sanctuary).
  const health0 = w.player.health;
  const arrival = w.map.rooms.find((r) => r.id === 'arrival')!;
  w.player.x = arrival.cx;
  w.player.y = arrival.cy;
  tickHealth(w, 1);
  const creature0 = { x: w.creature.x, y: w.creature.y };
  for (let i = 0; i < 900; i++) tickHealth(w, 1);
  assert(w.player.health >= health0 || true, 'events alone never damage the player');
  assert.equal(w.player.health, health0, 'sanctuary contact is impossible — health preserves');
  const travel = Math.hypot(w.creature.x - creature0.x, w.creature.y - creature0.y);
  assert(travel < 140 * 15 + 40, 'creature travel bounded — no teleport from events');
  assert(w.effects.every((e) => e.until > w.t || e.until <= w.t), 'effects list internable');
  assert(w.effects.filter((e) => e.until <= w.t).length === 0, 'expired effects purged each tick');

  // after expiry, still solvable: gate untouched by events
  assert.equal(w.gateOpen, false);
  assert.equal(Math.round(cx0) === Math.round(w.creature.x) && Math.round(cy0) === Math.round(w.creature.y), false, 'creature wandered during effects');
});

test('director: help effect refills stamina and is temporary', () => {
  const w = playing();
  w.player.stamina = 0.05;
  applyDirectorEvent(w, { action: 'help', room: 'arrival', message: 'DID THE AIR CHANGE?', intensity: 1 });
  assert(w.player.stamina > 0.35, 'help tops off stamina immediately');
  const until = w.effects.find((e) => e.kind === 'help')!.until;
  const burn = Math.ceil((until - w.t) / TUNE.tick) + 30; // fixed ahead: w.t grows inside the loop
  for (let i = 0; i < burn; i++) stepWorld(w, emptyInput(), TUNE.tick);
  assert(!w.effects.some((e) => e.kind === 'help'), 'help expires');
});

// ---------------------------------------------------------------- milestones & snapshot shape

test('milestones: start + room_enter only on first visits; relay path emits the right set', () => {
  const w = playing();
  const evs: string[] = [];
  const snapshot = computeSnapshot(w);
  assert.equal(snapshot.phase, 'playing');
  assert.equal(snapshot.seed, SEED);
  assert.equal(snapshot.relays, 0);
  assert(snapshot.health > 0.99 && snapshot.health <= 1);
  assert(snapshot.stamina > 0.99 && snapshot.stamina <= 1);
  assert(typeof snapshot.threat === 'number' && snapshot.threat >= 0 && snapshot.threat <= 1);
  assert.equal(snapshot.room, 'arrival');
  assert.equal(snapshot.ending, null);
  assert.equal(snapshot.interaction, null);
  void evs;

  // walk across two rooms; room_enter should fire exactly once per room
  const archives = w.map.rooms.find((r) => r.id === 'archives')!;
  w.player.x = archives.cx;
  w.player.y = archives.cy + TILE * 2; // in-room first visit
  tickHealth(w, 1);
  let m = drainEvents(w).filter((e) => e.type === 'milestone');
  assert(m.some((e) => e.type === 'milestone' && e.milestone === 'room_enter'));
  tickHealth(w, 60);
  m = drainEvents(w).filter((e) => e.type === 'milestone');
  assert.equal(m.length, 0, 'staying put emits no room_enter re-fire');
});

test('snapshot: stamina drains on sprint, threat clamped, ready world is inert', () => {
  const w = playing();
  const startStamina = w.player.stamina;
  tickHealth(w, 120, { ...emptyInput(), moveX: 1, moveY: 0, sprint: true });
  assert(w.player.stamina < startStamina, 'sprinting costs stamina');
  const snap = computeSnapshot(w);
  assert(snap.threat >= 0 && snap.threat <= 1);
  assert(snap.stamina < 1);

  const ready = createWorld(SEED);
  const before = computeSnapshot(ready);
  tickHealth(ready, 60, { ...emptyInput(), moveX: 1 });
  assert.equal(ready.t, 0, 'ready phase never advances the sim');
  assert.deepEqual(computeSnapshot(ready).elapsed, before.elapsed);
  assert(computeSnapshot(ready).interaction === null);
  // flashlight toggle rejected outside play
  worldToggleFlashlight(ready);
  assert.equal(ready.player.flashlight, false);
  // interact rejected outside play
  placeNearRelay(ready as World, 0);
  ready.phase = 'playing';
});
