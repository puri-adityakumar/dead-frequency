# Dead Frequency — engine design notes

Compact 2.5D survival-horror engine on a fixed 1/60 tick. `createGame(canvas, options): GameController` (see `../shared/contracts`). Pure simulation (`sim.ts`), DOM-free navigation (`nav.ts`), seeded generation (`map.ts`), canvas renderer (`render.ts`), input plumbing (`input.ts`) and one controller loop (`controller.ts`).

## Numeric conventions

| Value    | Convention                                  | Reason                                                     |
| -------- | ------------------------------------------- | ---------------------------------------------------------- |
| `health` | Internal and `GameSnapshot`: `0..1` fraction. `DirectorState`: `0..100` percent. `0` ⇒ `dead` | `makeDirectorState` converts once at the API boundary |
| `stamina`| `0..1` fraction (1 = full)                  | same                                                       |
| `threat` | `0..1` fraction (`0.05` floor while dormant)| same                                                       |
| `elapsed`| seconds of **sim** time (frozen when paused)| deterministic replays                                      |
| `relays` | `0..3`                                      | gate unseals at 3                                          |
| `interaction` | short prompt string or `null`. Relay: `RESTORE RELAY [E]`; console: `OPERATOR CONSOLE [E]` or `GATE SEALED — n/3 RELAYS DARK` | single-prompt design; the UI stream may need to wrap in brackets/icons |
| `room`   | one of the 5 contract RoomIds               | nearest/containing room                                    |

DirectorState extras: `elapsed`, `visitedRooms` (first-visit set), `recentMessages` (≤6, oldest-first), `threat`. Messages are uppercase radio-fiction strings, sanitised (control chars → space, trimmed, ≤160 chars).

## Simulation (`sim.ts`)

- `createWorld(seed)` → inert `ready` world; `stepWorld(w, input, dt)` only advances while `playing` (fixed `TUNE.tick = 1/60`; clamps `dt ≤ 4 ticks` defensively).
- Player: walk 92, sprint 142 u/s, accel 640 u/s², radius 2.6. Stamina drains 0.27/s sprinting, regen 0.17/s after 0.55 s; sprint lockout until refill ≥ 0.14. Footstep cue every 34 u (sprint) / 44 u (walk).
- Health: contact damage 0.34 (three hits), knockback 125, i-frame grace 1.6 s, `hurtFlash`/shake decay. `near_death` fires once when health crosses ≤ 0.35.
- Creature: dormant until a second room is first-visited or t > 30 s. FSM `dormant/roam/stalk/hunt/stunned` (speeds 55/103/126, hunt+1.25 during director `hunt`). Senses: sight 205 (lit+LOS) / 95 (dark), hearing 175 sprint / 100 walk / 44 creep; every approach moves through `moveCircle` over the BFS walkable graph — **it never clips walls and never teleports**. Contact range 6.4; stunned 0.55 s after each swing. Reception (`arrival`) is a sanctuary: senses and attacks are masked while the player is inside.
- Flashlight attracts: sight in the dark is 95, lit 205; a lit beam through a gap also leaks hearing to a hunt-boosted creature.
- Threat folds proximity + FSM state + sanctuary + decoys into 0..1.

## Map generation (`map.ts`)

63×45 tiles at 8 u (`TILE`): void 0, floor 1, wall 2, gate 3. Five semantic rooms are placed in a shuffled 3×2 coarse grid (rooms never touch). MST over the four non-exit rooms + the exit as a leaf; 2-wide L-corridors with spine-inclusive strips (corner welded — see nav note below); two extra loop corridors are routed around `expand(exitRoom, 2)`.

The gate is the full 1-tile ring around the exit room (`TILE_GATE`). Rooms never touch and non-exit corridors are banned from that band, so the ring contains only the exit approach; sealing can never strand a relay room. Relay pedestals, the console and ~40 props are scattered with rejection sampling (`placeFree` clearances: arrival spawn 11.2 u, relays `r+9.6`, console `r+12.8`, inter-prop `r1+r2+4.4`); big colliders mark their tiles in `propMap` so BFS treats them as obstacles while collision pushes bodies around them.

Verified properties (sweep over seeds 1..200, plus the contract seeds): every relay approachable pre-gate, exit room sealed at relays 0..2, console approach reachable at relays 3, gate ≥ 2 tiles, props 12..60, waypoints ≥ 20.

## Navigation (`nav.ts`)

- `tileSolid` (walls/void, gate closed), `circleBlocked` (centre + two concentric 8-sample rings + prop colliders), `moveCircle` (axis-separated slide, sub-steps when |d| > TILE − r) — the player and creature resolve through the same oracle; no tunneling.
- `bfsPath` over the walkable tile graph with a fixed neighbour order; either endpoint that lands on a coarse-blocked tile (a prop-shadowed tile, e.g. inside a relay pedestal's shadow) is repaired to `nearestWalkableAround` before the search, so no recursive fallback and no freeze when a body dances against furniture.
- `reachableSet(map, gateOpen, …)` is the solvability oracle the tests use.

A known seam class in this map genre is the corridor corner: two 2-wide strips must overlap at the L-corner or the wall pass seals the diagonal gap and strands a room. Strips are therefore spine-inclusive (`(y, y+1)` / `(x, x+1)`, no random lane offset), which guarantees every corner welds.

## Rendering (`render.ts`)

All procedural, no external assets, no 3D. DPR capped at 2, with a 3800-pixel longest-side scaling target. `scale = clamp(min(cssH/144, cssW/210), 2.8, 8)` keeps a room and its exits visible. Passes: frame-time-independent camera smoothing/shake → culled floor → room captions → per-row painter (y-sorted props with raised wall faces, gate barrier) → offscreen lightmap (emergency fixtures, flashlight cone, relay teal, threat red, add-lights then multiply) → unlit glows → vignette/threat/hurt/grain/phase washes → reticle. Effects use simulation time for expiry. Ready phase renders a quiet ambient scene of the same facility.

Lighting keeps a readable cool ambient floor instead of multiplying already-dark
surfaces into black. Warm archive lamps and cool emergency fixtures have visible
fluorescent strips and localized pools. The player has a brighter coat, cool rim,
and reflective shoulder tape; this changes presentation, not stealth or sensing.
Cool player bounce remains present whether the torch is on or off.

`lighting.ts` traces five nested flashlight lobes with 41 rays per lobe. Rays
sample at quarter-tile intervals, stop at walls and sealed gates, and slightly
overlap the first surface to light its face. Open gates pass light. This is
visual-only tile occlusion, not prop shadowing or a change to collision/AI.
Canvas and CSS vignettes/scanlines are kept light enough not to erase the pools.
`npm run test:lighting` renders 14 isolated scenes and a directional beam probe
in Chrome without a server or network access, checking shadow readability,
beam visibility, relay payoff, and the open exit gate.

## Input (`input.ts`)

Window-level keyboard (WASD/arrows, Shift sprint, E/F edges), canvas pointer aim; arrows preventDefault only while playing, `visibilitychange`/blur clear held keys, form controls are never hijacked (keydown is swallowed when a form control is in the composed path). `setTouchInput(x, y, sprint)` stores an explicit analogue vector in **−1..1** — the controller passes it straight into `moveIntent`, magnitudes > 1 get normalised.

## Director events (`applyDirectorEvent`)

Safety matrix (all effects expire by wall-of-sim time; world grid never mutated; gate untouched):

| action            | effect                                                                                    | expiry      |
| ----------------- | ----------------------------------------------------------------------------------------- | ----------- |
| `whisper`         | threat +0.04..0.10                                                                        | instant     |
| `lights_flicker`  | flicker render effect (2..6 s by intensity), threat +≤0.03                                | 2–6 s       |
| `false_alarm`     | decoy waypoint near the event room pulls a calm creature (stalk speed 4–7 s)              | 3–7 s       |
| `hunt`            | senses×1.25 + speed×1.08 (wakes dormant creature)                                          | 4–9 s       |
| `help`            | stamina +0.4, regen ×4, creature senses ×0.55, sprint unblocked                            | 5–8 s       |

Validation: unknown action/room rejected; non-string `message` rejects the whole event (contract types it `string`); messages sanitised ≤160 chars; effects capped at 8, messages at 6. Events arriving while not `playing` are queued as messages only.

## Controller (`controller.ts`)

rAF accumulator: fixed 1/60 steps, max 6 per frame, spiral-of-death guard; snapshot ≤10 Hz with immediate emit on any phase flip; boot snapshot on construction; `start` only from `ready` and fires the `start` milestone; pause clears held input; `reset(seed?)` rebuilds the ready world and re-centres the camera; destroy cancels RAF, detaches all input/resize listeners and observers; sim/milestone/sound loops swallow UI callback throws so the engine cannot be broken by the audio/UI layer.

## Known caveats for the integrating stream

1. Snapshot `health/stamina/threat` are 0..1 fractions. Director telemetry converts health to 0..100 percent for server policy; threat stays fractional.
2. `interaction` is the full prompt line (e.g. `RESTORE RELAY [E]`) — style it as one token instead of the bracketed pattern.
3. All sound goes through `onSound` (`step | relay | hurt | static | alarm | ending`); the engine itself plays nothing. `static` and `step` are rate-limited inside the sim.
4. Milestones emit at most once each except `room_enter`/`relay_restored` (first-visit / per-relay). `onMilestone` receives the full DirectorState.
5. `setTouchInput` coordinates are assumed −1..1 per axis; values beyond are normalised by magnitude, so analog sticks and digital D-pads both map cleanly.
6. No debug shortcuts are wired: nothing skips the relay gate or the ending choice.
7. `elapsed` freezes while paused/dead/choice — age the radio static from it, not wall-clock, for replayable runs.
