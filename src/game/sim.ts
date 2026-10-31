/**
 * Dead Frequency — pure simulation.
 *
 * No DOM, no Math.random, no wall-clock: createWorld(seed) + stepWorld(world,
 * input, dt) on a fixed 1/60 tick is fully reproducible from the seed alone.
 * Everything the renderer/controller needs lives on the plain World object.
 *
 * Director events are safe by construction: they may nudge threat, flicker
 * lights, dangle a decoy, or stiffen the creature briefly — they can never
 * teleport anything, kill the player, or seal progress (the gate is opened by
 * relays only; the world grid is never mutated after generation).
 */

import type { DirectorEvent, DirectorState, GameSnapshot, Milestone, RoomId, SoundCue } from '../shared/contracts';
import { hasLos, moveCircle, bfsPath, nearestWalkableAround, tileSolid } from './nav';
import type { GameMap, RelaySite } from './map';
import { TILE, createMap, roomAtPoint } from './map';
import type { RNG } from './rng';
import { clamp, mulberry32 } from './rng';

export const TUNE = {
  tick: 1 / 60,
  player: {
    radius: 2.6,
    walk: 92,
    sprint: 142,
    accel: 640,
    staminaMax: 1,
    staminaDrain: 0.27, // per second while sprinting
    staminaRegen: 0.17, // per second while recovering
    regenDelay: 0.55, // seconds after the last sprint before regen starts
    sprintLockout: 0.14, // stamina must refill to this before sprinting again
  },
  creature: {
    radius: 3.0,
    roam: 55,
    stalk: 103,
    hunt: 126,
    attackRange: 6.4, // contact = sum of radii + sliver; collision prevents inside
    damage: 0.34, // three hits kill, but grace + knockback make it fair
    iframe: 1.6,
    stunOnAttack: 0.55,
    knockback: 125,
    retargetInterval: 0.75,
    loseAfter: 2.8, // seconds without a trace before it settles to roaming
    lingerAfter: 1.6,
    waypointIdle: 1.4,
  },
  senses: {
    sightLit: 205, // flashlight ON and line of sight — it reads your beam
    sightDark: 95,
    hearingSprint: 175,
    hearingWalk: 100,
    hearingCreep: 44,
    helpDim: 0.55,
    huntBoost: 1.25,
  },
  interactRadius: 10.5,
  consoleRadius: 11.5,
  activateAfter: 30, // hard cap: creature wakes even if the player lingers in reception
  threat: { rise: 1.6, fall: 0.4 },
  nearDeathAt: 0.35,
  messageCap: 6,
  effectCap: 8,
} as const;

export type SimAction = { type: 'sound'; cue: SoundCue } | { type: 'milestone'; milestone: Milestone };

export type SimEvent = SimAction;

export interface Effect {
  kind: 'flicker' | 'hunt' | 'help' | 'decoy';
  until: number;
  intensity: number;
  tx?: number;
  ty?: number;
}

export interface CreatureState {
  x: number;
  y: number;
  state: 'dormant' | 'roam' | 'stalk' | 'hunt' | 'stunned';
  nextFsm: CreatureState['state'];
  target: { x: number; y: number } | null;
  lastKnown: { x: number; y: number } | null;
  path: Array<{ x: number; y: number }>;
  pathI: number;
  retargetTimer: number;
  lostTimer: number;
  lingerTimer: number;
  idleTimer: number;
  stunTimer: number;
  decoyUntil: number;
  anim: number;
  blink: number;
}

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aimX: number;
  aimY: number;
  facingX: number;
  facingY: number;
  flashlight: boolean;
  health: number;
  stamina: number;
  sprintBlocked: boolean;
  regenTimer: number;
  iframe: number;
  hurtFlash: number;
  stepMeter: number;
  sprinting: boolean;
  room: RoomId;
  visitedFirst: Set<RoomId>;
}

export interface World {
  seed: number;
  map: GameMap;
  rng: RNG;
  t: number; // in-sim time (advanced only while playing)
  phase: 'ready' | 'playing' | 'paused' | 'dead' | 'choice' | 'won';
  player: PlayerState;
  creature: CreatureState;
  creatureActive: boolean;
  relays: RelaySite[];
  relayDone: boolean[];
  relayGlow: number[];
  relayCount: number;
  gateOpen: boolean;
  threat: number;
  staticTimer: number;
  radioTimer: number;
  messages: string[]; // bounded, oldest dropped first
  effects: Effect[];
  events: SimEvent[];
  fired: { start: boolean; nearDeath: boolean; exitReady: boolean };
  choiceMade: 'release' | 'shutdown' | null;
  interaction: string | null;
  shake: number;
}

export interface SimInput {
  /** Normalised move intent; magnitude <= 1. Zero when inactive. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  /** Aim intent in world-space deltas from the player, or 0/0 when unset. */
  aimActive: boolean;
  aimX: number;
  aimY: number;
}

export function emptyInput(): SimInput {
  return { moveX: 0, moveY: 0, sprint: false, aimActive: false, aimX: 0, aimY: 0 };
}

const FIRST_ROOM_LINES: Record<RoomId, string> = {
  arrival: 'RECEPTION. THE FLOOR IS STILL COLD.',
  medical: 'MEDICAL WARD. NOTHING IN HERE IS TIDY.',
  archives: 'ARCHIVES. SOMEONE READ EVERYTHING HERE.',
  reactor: 'REACTOR HALL. THE CORE IS STILL WARM.',
  exit: 'GATE ATRIUM. ONE FREQUENCY LEFT.',
};

const RADIO_LINES: readonly string[] = [
  'A CARRIER PULSE SWEEPS THROUGH THE BAND.',
  'STATIC RESHAPES ITSELF. LIKE LISTENING.',
  'THE PA ANNOUNCES SUBLEVEL THREE. PA IS DEAD.',
  'A TONE ANSWERS YOU. SLOWER THAN YOUR TONE.',
  'FLUORESCENTS BREATHE HERE, OFF-COUNT.',
];

export function pushMessage(w: World, text: string): void {
  w.messages.push(text);
  while (w.messages.length > TUNE.messageCap) w.messages.shift();
}

export function createWorld(seed: number): World {
  const map = createMap(seed);
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const world: World = {
    seed: seed >>> 0,
    map,
    rng,
    t: 0,
    phase: 'ready',
    player: {
      x: map.spawn.x,
      y: map.spawn.y,
      vx: 0,
      vy: 0,
      aimX: 0,
      aimY: -1,
      facingX: 0,
      facingY: -1,
      flashlight: false,
      health: 1,
      stamina: 1,
      sprintBlocked: false,
      regenTimer: 0,
      iframe: 0,
      hurtFlash: 0,
      stepMeter: 0,
      sprinting: false,
      room: 'arrival',
      visitedFirst: new Set<RoomId>(['arrival']),
    },
    creature: {
      x: map.creatureSpawn.x,
      y: map.creatureSpawn.y,
      state: 'dormant',
      nextFsm: 'dormant',
      target: null,
      lastKnown: null,
      path: [],
      pathI: 0,
      retargetTimer: 0,
      lostTimer: 0,
      lingerTimer: 0,
      idleTimer: 0,
      stunTimer: 0,
      decoyUntil: 0,
      anim: 0,
      blink: 0,
    },
    creatureActive: false,
    relays: map.relays,
    relayDone: map.relays.map(() => false),
    relayGlow: map.relays.map(() => 0),
    relayCount: 0,
    gateOpen: false,
    threat: 0.05,
    staticTimer: 0,
    radioTimer: 42,
    messages: [],
    effects: [],
    events: [],
    fired: { start: false, nearDeath: false, exitReady: false },
    choiceMade: null,
    interaction: null,
    shake: 0,
  };
  pushMessage(world, 'CARRIER LOST — THREE RELAYS DARK.');
  pushMessage(world, 'RESTORE THE RELAYS. FOLLOW THE PAINTED NUMBERS.');
  pushMessage(world, 'KEEP YOUR BEAM SHORT. IT READS LIGHT.');
  return world;
}

export function drainEvents(w: World): SimEvent[] {
  if (w.events.length === 0) return [];
  const drained = w.events;
  w.events = [];
  return drained;
}

export function setPhase(w: World, phase: World['phase']): void {
  w.phase = phase;
}

function insideRoom(w: World, x: number, y: number): { room: RoomId | null; safe: boolean } {
  const room = roomAtPoint(w.map, x, y);
  const safe = rectRoomHasPoint(w.map, 'arrival', x, y);
  return { room, safe };
}

function rectRoomHasPoint(map: GameMap, id: RoomId, x: number, y: number): boolean {
  for (const r of map.rooms) {
    if (r.id !== id) continue;
    return x >= r.x0 * TILE && x <= (r.x1 + 1) * TILE && y >= r.y0 * TILE && y <= (r.y1 + 1) * TILE;
  }
  return false;
}

function effectActive(w: World, kind: Effect['kind']): boolean {
  for (const e of w.effects) if (e.kind === kind && e.until > w.t) return true;
  return false;
}

function effectOf(w: World, kind: Effect['kind']): Effect | null {
  for (const e of w.effects) if (e.kind === kind && e.until > w.t) return e;
  return null;
}

function effectIntensity(w: World, kind: Effect['kind'], fallback = 0.5): number {
  const e = effectOf(w, kind);
  return e ? e.intensity : fallback;
}

/** Rumble toward the player: proximity folds into the phase's base level. */
function computeThreat(w: World): number {
  const c = w.creature;
  const dist = Math.hypot(c.x - w.player.x, c.y - w.player.y);
  const prox = clamp(1 - dist / 300, 0, 1) ** 2;
  let base = 0.05;
  if (!w.creatureActive) base = 0.05;
  else if (c.state === 'hunt') base = 0.78 + prox * 0.22;
  else if (c.state === 'stalk') base = 0.32 + prox * 0.5;
  else if (c.state === 'stunned') base = 0.45 + prox * 0.3;
  else base = 0.1 + prox * 0.3;
  if (insideRoom(w, w.player.x, w.player.y).safe) base = Math.min(base, 0.18);
  if (effectActive(w, 'decoy')) base = Math.min(base, 0.4);
  return base;
}

function emitSound(w: World, cue: SoundCue): void {
  w.events.push({ type: 'sound', cue });
}

function emitMilestone(w: World, milestone: Milestone): void {
  w.events.push({ type: 'milestone', milestone });
}

/** Fixed simulation step. Input is already merged/cleaned by the controller. */
export function stepWorld(w: World, input: SimInput, dt: number): void {
  if (w.phase !== 'playing') return;
  dt = Math.min(dt, TUNE.tick * 4); // defensive: controller feeds fixed ticks
  w.t += dt;

  // --- effects: purge expired ---
  if (w.effects.length > 0) {
    w.effects = w.effects.filter((e) => e.until > w.t);
  }
  const helpActive = effectActive(w, 'help');
  const huntActive = effectActive(w, 'hunt');

  // --- player movement ---
  const p = w.player;
  const moveLen = Math.hypot(input.moveX, input.moveY);
  const moveNX = moveLen > 0.0001 ? input.moveX / Math.max(moveLen, 1) : 0;
  const moveNY = moveLen > 0.0001 ? input.moveY / Math.max(moveLen, 1) : 0;
  const wantsSprint = input.sprint && moveLen > 0.35;
  let sprinting = wantsSprint && !p.sprintBlocked && p.stamina > 0;
  if (helpActive) sprinting = wantsSprint;
  if (wantsSprint && p.stamina <= 0) p.sprintBlocked = true;
  if (p.sprintBlocked && p.stamina >= TUNE.player.sprintLockout) p.sprintBlocked = false;
  p.sprinting = sprinting;
  const speedBase = sprinting ? TUNE.player.sprint : TUNE.player.walk;
  const speed = speedBase * (effectActive(w, 'flicker') ? 1 : 1) * (helpActive ? 1.06 : 1);
  const targetVX = moveNX * speed;
  const targetVY = moveNY * speed;
  const maxDv = TUNE.player.accel * dt;
  p.vx += clamp(targetVX - p.vx, -maxDv, maxDv);
  p.vy += clamp(targetVY - p.vy, -maxDv, maxDv);
  const px0 = p.x;
  const py0 = p.y;
  const moved = moveCircle(w.map, w.gateOpen, p.x, p.y, p.vx * dt, p.vy * dt, TUNE.player.radius);
  p.x = moved.x;
  p.y = moved.y;

  // stamina bookkeeping
  if (sprinting) {
    p.stamina = Math.max(0, p.stamina - TUNE.player.staminaDrain * dt);
    p.regenTimer = TUNE.player.regenDelay;
  } else {
    p.regenTimer = Math.max(0, p.regenTimer - dt);
    if (p.regenTimer <= 0) {
      p.stamina = Math.min(1, p.stamina + TUNE.player.staminaRegen * (helpActive ? 4 : 1) * dt);
      if (!p.sprintBlocked && p.stamina >= TUNE.player.sprintLockout) p.sprintBlocked = false;
    }
  }

  // footsteps → sound callback (carrier noise the creature can hear)
  const actual = Math.hypot(p.x - px0, p.y - py0);
  p.stepMeter += actual;
  const stepThreshold = sprinting ? 34 : 44;
  if (moveLen > 0.25 && p.stepMeter >= stepThreshold) {
    p.stepMeter = 0;
    emitSound(w, 'step');
  }

  // --- facing/aim ---
  if (input.aimActive && (input.aimX !== 0 || input.aimY !== 0)) {
    const al = Math.hypot(input.aimX, input.aimY) || 1;
    p.aimX = input.aimX / al;
    p.aimY = input.aimY / al;
    p.facingX = p.aimX;
    p.facingY = p.aimY;
  } else if (moveLen > 0.25) {
    p.facingX = moveNX;
    p.facingY = moveNY;
    p.aimX = moveNX;
    p.aimY = moveNY;
  }

  // --- room tracking ---
  const at = insideRoom(w, p.x, p.y);
  if (at.room !== null && at.room !== p.room) {
    p.room = at.room;
    if (!p.visitedFirst.has(at.room)) {
      p.visitedFirst.add(at.room);
      pushMessage(w, FIRST_ROOM_LINES[at.room]);
      emitMilestone(w, 'room_enter');
    }
  }

  // --- interaction prompt ---
  w.interaction = interactionHere(w);

  // --- creature awakening ---
  if (!w.creatureActive && (p.visitedFirst.size > 1 || w.t > TUNE.activateAfter)) {
    w.creatureActive = true;
    w.creature.state = 'roam';
    w.creature.nextFsm = 'dormant';
    pushMessage(w, 'PIGGYBACK STATIC ON YOUR CHANNEL. IT MOVES.');
    emitSound(w, 'static');
  }

  // --- ambient radio colour (seeded, never per-frame) ---
  w.radioTimer -= dt;
  if (w.radioTimer <= 0) {
    w.radioTimer = 46 + w.rng.range(0, 26);
    pushMessage(w, w.rng.pick(RADIO_LINES));
  }

  // --- creature ---
  stepCreature(w, dt, helpActive, huntActive);

  // --- threat, rumble timers, decays ---
  const tTarget = computeThreat(w);
  const rate = tTarget > w.threat ? TUNE.threat.rise : TUNE.threat.fall;
  w.threat = clamp(w.threat + Math.sign(tTarget - w.threat) * Math.min(rate * dt, Math.abs(tTarget - w.threat)), 0, 1);
  const dist = Math.hypot(w.creature.x - p.x, w.creature.y - p.y);
  w.staticTimer -= dt;
  if (w.creatureActive && dist < 150 && w.staticTimer <= 0) {
    w.staticTimer = clamp(dist / 150, 0.28, 1) * 2.6;
    emitSound(w, 'static');
  }
  p.iframe = Math.max(0, p.iframe - dt);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt * 1.6);
  w.shake = Math.max(0, w.shake - dt * 2.4);
  for (let i = 0; i < w.relayGlow.length; i++) w.relayGlow[i] = Math.max(0, w.relayGlow[i] - dt);

  // --- death wait state ---
  if (p.health <= 0) {
    p.health = 0;
    w.phase = 'dead';
  }
}

function interactionHere(w: World): string | null {
  const p = w.player;
  for (let i = 0; i < w.relays.length; i++) {
    if (w.relayDone[i]) continue;
    const r = w.relays[i]!;
    if (Math.hypot(r.x - p.x, r.y - p.y) <= TUNE.interactRadius) return 'RESTORE RELAY [E]';
  }
  const c = w.map.consoleSite;
  if (Math.hypot(c.x - p.x, c.y - p.y) <= TUNE.consoleRadius) {
    if (w.gateOpen) return 'OPERATOR CONSOLE [E]';
    return `GATE SEALED — ${3 - w.relayCount}/3 RELAYS DARK`;
  }
  return null;
}

function stepCreature(w: World, dt: number, helpActive: boolean, huntActive: boolean): void {
  const c = w.creature;
  c.anim += dt;
  if (!w.creatureActive) return;
  const p = w.player;
  const safe = insideRoom(w, p.x, p.y).safe;
  const dist = Math.hypot(c.x - p.x, c.y - p.y);
  const los = hasLos(w.map, w.gateOpen, c.x, c.y, p.x, p.y);

  // --- sensing ---
  let knows = false;
  let sees = false;
  if (!safe) {
    const dim = helpActive ? TUNE.senses.helpDim : 1;
    const boost = huntActive ? TUNE.senses.huntBoost : 1;
    const sight = (p.flashlight ? TUNE.senses.sightLit : TUNE.senses.sightDark) * dim * boost;
    if (los && dist <= sight) {
      sees = true;
      knows = true;
      c.lastKnown = { x: p.x, y: p.y };
      c.lostTimer = 0;
    } else if (!los) {
      // lit beam through a gap still leaks a whisper of artefact
      if (p.flashlight && dist < sight * 0.55 && boost > 1) {
        knows = true;
        c.lastKnown = { x: p.x, y: p.y };
      }
    }
    const hearingBase = p.sprinting
      ? TUNE.senses.hearingSprint
      : Math.hypot(p.vx, p.vy) > TUNE.player.walk * 0.3
        ? TUNE.senses.hearingWalk
        : TUNE.senses.hearingCreep;
    const hearing = hearingBase * dim * boost;
    if (!knows && dist <= hearing) {
      knows = true;
      c.lastKnown = { x: p.x, y: p.y };
      c.lostTimer = 0;
    }
  } else {
    // Sanctuary: presence is masked inside reception.
    c.lastKnown = null;
    if (c.state === 'hunt' || c.state === 'stalk') c.state = 'roam';
  }

  if (c.stunTimer > 0) {
    c.stunTimer -= dt;
    if (c.stunTimer > 0) {
      c.state = 'stunned';
      return;
    }
    c.state = c.nextFsm === 'stunned' ? 'roam' : c.nextFsm;
  }

  // --- state transitions ---
  if (safe) {
    c.state = 'roam';
  } else if (sees) {
    c.state = 'hunt';
    c.lostTimer = 0;
  } else {
    if (!knows) c.lostTimer += dt;
    else c.lostTimer = 0;
    if (c.state === 'hunt' && c.lostTimer >= TUNE.creature.loseAfter) c.state = 'stalk';
    // A decoy (false_alarm) pulls a calm creature onto a false thread.
    const decoyActive = effectActive(w, 'decoy');
    if (decoyActive && (c.state === 'roam' || c.state === 'stalk') && !knows) {
      c.state = 'stalk';
    }
    if (c.state === 'stalk') {
      if (knows) c.lastKnown = { x: p.x, y: p.y }; // audio re-locates the body
      if (c.lostTimer >= TUNE.creature.loseAfter + TUNE.creature.lingerAfter) {
        c.state = 'roam';
        c.lingerTimer = 0;
        c.target = null;
      }
    }
  }

  // --- target selection ---
  const decoyActive = effectActive(w, 'decoy') && !sees;
  let goal: { x: number; y: number } | null = null;
  let speed: number = TUNE.creature.roam;
  if (decoyActive) {
    const de = effectOf(w, 'decoy');
    if (de) {
      goal = { x: de.tx ?? c.x, y: de.ty ?? c.y };
      speed = TUNE.creature.stalk;
      if (c.lastKnown === null || Math.hypot(c.lastKnown.x - goal.x, c.lastKnown.y - goal.y) > 4) c.lastKnown = { x: goal.x, y: goal.y };
    }
  }
  if (!goal) {
    if (c.state === 'hunt' && knows) {
      goal = c.lastKnown;
      speed = TUNE.creature.hunt * (huntActive ? 1.08 : 1);
      if (los && dist > 2) {
        goal = { x: p.x, y: p.y }; // locks eyes on the actual body when visible
      }
      if (los && p.flashlight) speed *= 1.04;
    } else if (c.state === 'stalk' && c.lastKnown) {
      goal = c.lastKnown;
      speed = TUNE.creature.stalk;
      if (knows) {
        goal = { x: p.x, y: p.y };
      }
    } else {
      c.idleTimer -= dt;
      if (c.target === null || c.pathI >= c.path.length) {
        if (c.idleTimer <= 0) {
          c.target = pickRoamTarget(w);
          c.pathI = 0;
          c.path = [];
          c.retargetTimer = 0;
        }
      }
      goal = c.target;
      speed = TUNE.creature.roam;
    }
  }

  // --- repath + follow (BFS over walkable tiles — never wall-clips) ---
  c.retargetTimer -= dt;
  const needsPath = c.path.length === 0 || c.pathI >= c.path.length || c.retargetTimer <= 0;
  if (goal && needsPath) {
    c.retargetTimer = TUNE.creature.retargetInterval * (c.state === 'hunt' ? 0.3 : 1);
    const path = bfsPath(w.map, w.gateOpen, c.x, c.y, goal.x, goal.y);
    if (path !== null) {
      c.path = path;
      c.pathI = 0;
    }
  }
  let dirX = 0;
  let dirY = 0;
  if (c.path.length > 0 && c.pathI < c.path.length) {
    while (c.pathI < c.path.length && Math.hypot(c.path[c.pathI]!.x - c.x, c.path[c.pathI]!.y - c.y) < 2.4) c.pathI++;
    const wp = c.path[Math.min(c.pathI, c.path.length - 1)]!;
    if (wp) {
      const wl = Math.hypot(wp.x - c.x, wp.y - c.y) || 1;
      dirX = (wp.x - c.x) / wl;
      dirY = (wp.y - c.y) / wl;
    }
    if (c.pathI >= c.path.length) {
      // arrived
      if (c.state === 'roam') {
        c.target = null;
        c.idleTimer = TUNE.creature.waypointIdle + w.rng.range(0, 1.2);
      } else if (c.state === 'stalk' && !knows) {
        c.lingerTimer += dt;
      }
    }
  } else if (goal) {
    // no path: direct steer (collision still refuses solids)
    const gl = Math.hypot(goal.x - c.x, goal.y - c.y) || 1;
    dirX = (goal.x - c.x) / gl;
    dirY = (goal.y - c.y) / gl;
  }

  if (dirX !== 0 || dirY !== 0) {
    const at = moveCircle(w.map, w.gateOpen, c.x, c.y, dirX * speed * dt, dirY * speed * dt, TUNE.creature.radius);
    c.x = at.x;
    c.y = at.y;
  }

  // --- attack ---
  const distAfter = Math.hypot(c.x - p.x, c.y - p.y);
  if (!safe && distAfter <= TUNE.creature.attackRange && w.player.iframe <= 0) {
    const al = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    p.vx += ((p.x - c.x) / al) * TUNE.creature.knockback;
    p.vy += ((p.y - c.y) / al) * TUNE.creature.knockback;
    p.iframe = TUNE.creature.iframe;
    p.health = Math.max(0, p.health - TUNE.creature.damage);
    p.hurtFlash = 1;
    w.shake = 1;
    w.threat = Math.min(1, w.threat + 0.35);
    c.stunTimer = TUNE.creature.stunOnAttack;
    c.nextFsm = c.state === 'hunt' ? 'hunt' : 'stalk';
    emitSound(w, 'hurt');
    if (p.health <= TUNE.nearDeathAt && !w.fired.nearDeath) {
      w.fired.nearDeath = true;
      emitMilestone(w, 'near_death');
      pushMessage(w, 'YOU ARE BLEEDING INTO THE BAND.');
    }
    if (p.health <= 0) {
      w.phase = 'dead';
    }
  }
}

function pickRoamTarget(w: World): { x: number; y: number } {
  const wps = w.map.waypoints;
  // seeded pick, biased away from the player's room to keep pressure pointed
  const candidates = wps.filter((wp) => Math.hypot(wp.x - w.player.x, wp.y - w.player.y) > 120);
  const pool = candidates.length > 0 ? candidates : wps;
  const t = pool[Math.floor(w.rng.next() * pool.length)] ?? { x: w.player.x, y: w.player.y };
  return t;
}

// ---------------------------------------------------------------------------
// Objective interactions
// ---------------------------------------------------------------------------

export function worldInteract(w: World): void {
  if (w.phase !== 'playing') return;
  const p = w.player;
  for (let i = 0; i < w.relays.length; i++) {
    if (w.relayDone[i]) continue;
    const r = w.relays[i]!;
    if (Math.hypot(r.x - p.x, r.y - p.y) <= TUNE.interactRadius) {
      w.relayDone[i] = true;
      w.relayGlow[i] = 2.2;
      w.relayCount++;
      emitSound(w, 'relay');
      emitMilestone(w, 'relay_restored');
      pushMessage(w, `RELAY ONLINE — ${w.relayCount}/3 CARRIER PHASES HOLD.`);
      if (w.relayCount >= 3 && !w.gateOpen) {
        w.gateOpen = true;
        emitSound(w, 'alarm');
        emitMilestone(w, 'exit_ready');
        pushMessage(w, 'GATE UNSEALED. THE ATRIUM CONSOLE IS LIVE.');
      }
      return;
    }
  }
  const c = w.map.consoleSite;
  if (Math.hypot(c.x - p.x, c.y - p.y) <= TUNE.consoleRadius) {
    if (w.gateOpen) {
      w.phase = 'choice';
      emitSound(w, 'static');
      pushMessage(w, 'CONSOLE LIVE. TWO FREQUENCIES TERMINATE HERE.');
    } else {
      emitSound(w, 'static');
      pushMessage(w, `CONSOLE DEAD HAND — ${3 - w.relayCount}/3 RELAYS STILL DARK.`);
    }
  }
}

export function worldToggleFlashlight(w: World): void {
  if (w.phase !== 'playing') return;
  w.player.flashlight = !w.player.flashlight;
  emitSound(w, 'static');
}

export function worldChooseEnding(w: World, ending: 'release' | 'shutdown'): void {
  if (w.phase !== 'choice') return;
  if (ending !== 'release' && ending !== 'shutdown') return;
  w.choiceMade = ending;
  w.phase = 'won';
  w.threat = 0.02;
  emitSound(w, 'ending');
  pushMessage(w, ending === 'release' ? 'YOU LET THE OPERATOR OUT. DEAD AIR CLEARS.' : 'YOU CUT THE FEED. THE BUILDING EXHALES.');
}

// ---------------------------------------------------------------------------
// Director events — safe, expiring, non-fatal
// ---------------------------------------------------------------------------

function sanitizeMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 160);
}

const ACTIONS = new Set<string>(['whisper', 'lights_flicker', 'false_alarm', 'hunt', 'help']);
const ROOMS = new Set<string>(['arrival', 'medical', 'archives', 'reactor', 'exit']);

export function applyDirectorEvent(w: World, event: DirectorEvent): void {
  if (!event || typeof event !== 'object') return;
  const action = String(event.action ?? '');
  if (!ACTIONS.has(action)) return;
  const room = String(event.room ?? '');
  if (!ROOMS.has(room)) return;
  const intensityRaw = Number(event.intensity);
  const intensity = Number.isFinite(intensityRaw) ? clamp(intensityRaw, 0, 1) : 0.5;
  // The contract types `message: string`; a present-but-non-string message is
  // outside the contract, so the whole event is rejected rather than coerced.
  if (typeof event.message !== 'string') return;
  const message = sanitizeMessage(event.message);
  if (message) pushMessage(w, message);

  if (w.phase !== 'playing') return; // radio still queued; effects wait for play

  switch (action) {
    case 'whisper': {
      w.threat = Math.min(1, w.threat + 0.04 + 0.06 * intensity);
      emitSound(w, 'static');
      break;
    }
    case 'lights_flicker': {
      pushEffect(w, { kind: 'flicker', until: w.t + 2 + 4 * intensity, intensity });
      w.threat = Math.min(1, w.threat + 0.03 * intensity);
      emitSound(w, 'static');
      break;
    }
    case 'false_alarm': {
      // Dangle a false thread: nearest reachable waypoint toward the event room.
      const roomName = String(room as RoomId);
      const eventRoom = w.map.rooms.find((r) => r.id === roomName)!;
      const from = { x: eventRoom.cx, y: eventRoom.cy };
      let target = nearestWalkableAround(w.map, w.gateOpen, Math.floor(from.x / TILE), Math.floor(from.y / TILE));
      if (!target) target = { x: eventRoom.cx, y: eventRoom.cy };
      pushEffect(w, { kind: 'decoy', until: w.t + 3 + 4 * intensity, intensity, tx: target.x, ty: target.y });
      w.creature.decoyUntil = w.t + 3 + 4 * intensity;
      w.creature.state = w.creature.state === 'hunt' ? 'hunt' : 'stalk';
      w.creature.retargetTimer = 0;
      emitSound(w, 'static');
      break;
    }
    case 'hunt': {
      pushEffect(w, { kind: 'hunt', until: w.t + 4 + 5 * intensity, intensity });
      if (!w.creatureActive) {
        w.creatureActive = true;
        w.creature.state = 'roam';
      }
      w.creature.retargetTimer = 0;
      emitSound(w, 'alarm');
      break;
    }
    case 'help': {
      pushEffect(w, { kind: 'help', until: w.t + 5 + 3 * intensity, intensity });
      w.player.stamina = Math.min(1, w.player.stamina + 0.4);
      w.player.regenTimer = 0;
      emitSound(w, 'static');
      break;
    }
  }
}

function pushEffect(w: World, effect: Effect): void {
  w.effects.push(effect);
  while (w.effects.length > TUNE.effectCap) w.effects.shift();
}

// ---------------------------------------------------------------------------
// Contract surfaces
// ---------------------------------------------------------------------------

export function makeDirectorState(w: World, milestone: Milestone): DirectorState {
  return {
    seed: w.seed,
    elapsed: round3(w.t),
    room: w.player.room,
    visitedRooms: [...w.player.visitedFirst],
    relays: w.relayCount,
    health: round3(clamp(w.player.health, 0, 1) * 100),
    flashlight: w.player.flashlight,
    threat: round3(w.threat),
    milestone,
    recentMessages: w.messages.slice(0, TUNE.messageCap),
  };
}

export function computeSnapshot(w: World): GameSnapshot {
  return {
    phase: w.phase,
    seed: w.seed,
    elapsed: round3(w.t),
    health: round3(w.player.health),
    relays: w.relayCount,
    room: w.player.room,
    flashlight: w.player.flashlight,
    stamina: round3(w.player.stamina),
    threat: round3(w.threat),
    interaction: w.interaction,
    ending: w.choiceMade,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function tileSolidAt(w: World, x: number, y: number): boolean {
  return tileSolid(w.map, w.gateOpen, Math.floor(x / TILE), Math.floor(y / TILE));
}
