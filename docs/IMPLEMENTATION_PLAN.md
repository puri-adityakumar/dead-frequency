# Dead Frequency — parallel implementation plan

## Scope

A compact 2.5D Canvas survival-horror game: restore three relays in a dead facility,
avoid one pursuing creature, then release or shut down a haunted operator.
No Three.js or actual 3D. Procedural graphics and Web Audio only.
Next.js + TypeScript serves the client and a same-origin Tinker director endpoint.
AI runs at milestones, never in the frame loop. Offline scripted fallback is
explicitly labelled; gameplay never waits on inference.

The supplied `skills/dark-sector` is reference material. Its original single-file,
no-network packaging is intentionally superseded by the user's Next.js/Tinker
choice. Do not change the supplied source. No explicit redistribution licence
was found in the supplied archive; use original implementation rather than
copying its source pending permission.

## Stable integration contract

`src/shared/contracts.ts` is owned by the orchestrator. Do not change it independently.
Engine exports `createGame(canvas: HTMLCanvasElement, options: GameOptions): GameController`
from `src/game/index.ts`. The controller owns keyboard/pointer movement, fixed-step
simulation, rendering, and canvas resizing. UI owns menus, HUD, radio messages,
touch controls, audio, and milestone fetches. UI mounts the canvas, creates and
destroys the controller once per mount. Engine emits snapshots at most 10 Hz.

POST `/api/director` receives a `DirectorState` and returns `DirectorResponse`.
Server validates both input and output. Events cannot teleport, instantly kill,
permanently block progression, or execute model-generated code. Intensity is 0–1.
Client only sends a bounded list of recent messages. No free-form user prompt.
Elapsed time is simulation seconds. Snapshot health, stamina, and threat are
0–1 fractions. Director health is 0–100 percent, converted by `makeDirectorState`;
director threat remains a 0–1 fraction.

## File ownership (shared checkout, no overlapping writers)

1. OpenCode GLM-5.3 Flash, `variant=max`: `src/game/**`, `tests/game*.test.ts`.
   Seeded solvable map, collision, relays, creature navigation, endings, polished
   Canvas wall depth/lighting, desktop input, touch-input plumbing, pure logic tests.
2. OpenCode GLM-5.3 Flash, `variant=max` (recovered after the Droid GLM run failed): `src/app/layout.tsx`,
   `src/app/page.tsx`, `src/app/globals.css`, `src/components/**`, `src/audio/**`.
   Responsive atmospheric shell, accessible menus/HUD/radio, audio, touch UI,
   controller integration, milestone fetch with cancellation/timeouts.
3. Droid GMI DeepSeek V4.1 Flash 1017, `reasoning_effort=max` (initial implementation complete;
   ownership transferred to the independent hardening delegate):
   `src/app/api/**`, `src/lib/director/**`, `tests/director*.test.ts`,
   `.env.example`, `docs/TINKER.md`.
   Bounded Zod schemas, secure server-only Tinker adapter, mockable tests,
   limits/timeouts/fallback, honest setup and fine-tuning eligibility documentation.
4. Droid GMI DeepSeek V4.1 Flash 1017, `reasoning_effort=max`:
   `scripts/smoke.mjs` and `docs/QA.md`. Real-browser smoke harness with a mocked
   director endpoint, no paid calls, no writes to engine or UI files.
5. Orchestrator: root configuration/dependencies/lockfile, shared contracts,
   integration fixes after writers finish, README, Render config, verification,
   final commits. Delegates must not commit, push, install packages, or spawn children.

## Execution and verification

- Prepare common dependencies and contract, then run all three workstreams concurrently.
- All delegates use max; orchestrator retains its existing setting.
- Retry failed work on the same model at max first. If failures persist or quota
  is exhausted, switch only within the user-approved GLM/DeepSeek pool.
  Cancel any replaced run before a replacement starts; announce the switch.
- Run pure unit tests, TypeScript checking, production build, and interaction smoke
  tests. Fix small review findings directly. Do not represent unrun checks as passing.
- Do not use secrets in delegates. No paid training or inference until budget approval.
- Tinker key has passed read-only auth; account had zero checkpoints. The OpenAI
  adapter needs an actual sampler checkpoint path, not a fabricated model path.
- Fine-tuning and baseline-vs-tuned evaluation are a subsequent budget-gated stage;
  an untuned prototype must not claim the Tinker prize requirement is complete.

## Integration result

All implementation, QA, and backend-hardening delegates have finished.
Orchestrator fixes aligned health units, isolated callbacks, restored ending
audio dispatch, corrected camera scale and lighting, bounded engine-load
retries, and removed narrow-screen HUD overlap.

Verified: 56 unit tests, TypeScript, production build, 14 isolated lighting
scenes plus a directional beam probe, and 27 post-lighting Chrome smoke checks
with no failures, warnings, or skips. The real standalone API returns fallback
without credentials and rejects foreign Origins. Browser inference is mocked;
no paid Tinker calls or training ran. No Render deployment, public push, or
challenge submission has been performed.
