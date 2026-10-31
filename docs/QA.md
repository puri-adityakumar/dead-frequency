# Dead Frequency QA smoke track

Independent end-to-end checks for the shipped UI and engine. The harness drives
the real app in a locally installed Chrome through `playwright-core`, and every
`POST /api/director` is intercepted and answered with explicit scripted data.
No request can reach Tinker, and no inference credits are spent.

Owned files: `scripts/smoke.mjs`, `scripts/lighting-smoke.mjs`,
`tests/game-lighting.test.ts`, `docs/QA.md`. The harnesses do not change
application code, configuration, or deployment files.

## Run it

```bash
# terminal 1 — app must already be running
npm run dev            # or: npm run build && npm start

# terminal 2
node scripts/smoke.mjs http://localhost:3000
```

Setup requirements:

- Node 20+ and the repo's existing `playwright-core` (1.64.1) dev dependency.
- A local Chrome, Chromium, Edge, or Brave install. Defaults cover common macOS
  and Linux locations. Override with `CHROME_PATH`:

  ```bash
  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    node scripts/smoke.mjs http://localhost:3000
  ```

- The harness never starts, restarts, or watches a server. If the URL is not
  reachable, `page.load` fails and the process exits 1.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--headed` | Show the browser window while it runs. |
| `--timeout-ms=25000` | Navigation timeout. |
| `--engine-timeout-ms=20000` | How long to wait for the HUD/ready overlay. |
| `--action-timeout-ms=8000` | Per-interaction wait budget. |
| `--total-timeout-ms=180000` | Whole-run watchdog. |
| `--skip-slow` | Skip the 9-second director-timeout scenario. |
| `--skip-touch` | Skip the narrow-screen touch scenario. |
| `--out=DIR` | Write diagnostics somewhere other than `test-results/smoke/<stamp>`. |

Exit codes: `0` = no failures or blocked checks, `1` = failed or blocked, `2` = setup or
configuration error (missing URL, missing Chrome, bad flag).

## What is checked

Desktop flow (1280×800, headless by default):

- Page loads, title and `main[aria-label="Dead Frequency"]` render, canvas has a
  nonzero box and backing store.
- Engine/HUD mounts within the engine budget. An honest boot/offline panel is
  reported as **blocked**, not passed; a lifecycle fault is a failure.
- **Begin transmission** reaches the playing phase.
- Canvas contains actual visible rendered pixels (sampled luminance range and
  non-black share, not just a sized element).
- One intercepted `POST /api/director` request is validated against
  `DirectorState` bounds (room/milestone enums, health, threat, relays,
  `recentMessages` ≤ 8, each message ≤ 160 characters, unique visited rooms).
- The scripted `source: "fallback"` response is shown as fallback in the HUD and
  as a `FALLBACK` radio entry with the scripted message. It must never claim
  `live`.
- Keyboard movement: `W` plus `Shift` produces a room change, a stamina drop, or
  a frame delta clearly above idle animation drift. Evidence is recorded either
  way.
- `F` changes the explicit flashlight status and lights the scene. Evidence
  includes local grid-cell luminance gains as well as whole-frame changes.
  Inconclusive beam visibility is a **warning**, not a pass.
- `Escape` opens the pause overlay and the elapsed clock stops; **Resume** closes
  it and the clock advances. Two more single `Escape` presses must toggle
  pause/resume cleanly.
- `Restart run` clears the overlay and resets the elapsed clock.
- `window` keydown listener count (via CDP `getEventListeners`) does not grow
  across pause/resume cycles.
- Reload remounts the engine and starts a new run without uncaught errors.
- No uncaught page errors and no unexpected console errors during the flow.

Director failure conditions (each in its own context, all intercepted):

| Scenario | Mock behavior | Expected UI |
| --- | --- | --- |
| `director.error` | HTTP 500 JSON | HUD fallback, `FALLBACK` tag, `director endpoint 500` note |
| `director.abort` | `route.abort("failed")` | HUD fallback, `FALLBACK` tag, unreachable/timeout note |
| `director.slow` | 1.5s delay, then valid fallback | gameplay clock keeps advancing during the request, then fallback |
| `director.timeout` | 9.7s delay (longer than the client's 9s timeout) | client aborts at 9s, HUD fallback, `director timeout` note |

Narrow-screen touch flow (390×844, `isMobile`, `hasTouch`):

- Touch layer appears when the browser reports a coarse pointer.
- HUD, vitals, message banner, radio, and touch controls do not overlap.
- Dragging the movement stick moves the nub and it recentres on release.
- `LAMP` changes actual flashlight state; `USE` is visible and clickable.
- No uncaught browser errors during touch interaction.

## Interception policy

`context.route("**/api/director", …)` is installed in every browser context,
including the touch and failure contexts. The handler only accepts `POST`; all
other methods continue. Responses are generated in the script:

- Fallback: `{ source: "fallback", event: { action: "whisper", room: <request
  room>, message: "mock fallback …", intensity: 0.05 }, reason: "mock_scripted" }`
- Failure modes: HTTP 500, network abort, delayed success, delayed past timeout.

Nothing is proxied to the real route, so the server's Tinker adapter is never
exercised by this harness. Backend correctness remains covered by the 33
`tests/director*.test.ts` unit tests.

## Deterministic lighting scenes

`npm run test:lighting` does not need a running server. It compiles the local
renderer sources in memory, aborts every network request, and renders fixed
camera, fixed seed scenes in headless Chrome. Captures and `report.json` go to
`test-results/lighting/` (local, git-ignored).

The suite renders **14 scenes**:

- All five rooms with the flashlight off and on.
- Medical, archives, and reactor with the matching relay restored.
- Exit with the gate open and all three relays restored.

Checks use raw canvas luminance (0–255) sampled across visible room floor:

- At least 1,000 floor samples per scene.
- Mean at least 40, p10 at least 22, p90 at least 40, and p90−p10 at least 12.
- Flashlight on must raise the room mean by at least 0.5.
- Restored relay must raise the room mean by at least 4 and its local
  10–20 world-unit halo by at least 4.
- Opening the exit gate must raise the exit room mean by at least 4.
- A directional probe renders the same frame twice, first with the beam off and
  then on. The mean gain in the forward cone (within 60 world units) must be at
  least 4 and at least 4 above the rear mean. A radial glow would fail this.

Verified on 2026-10-31: **14 scenes and the directional probe passed**.

| Room | Off mean | On mean | Restored / gate mean |
| --- | ---: | ---: | ---: |
| Arrival | 72.4 | 73.2 | — |
| Medical | 54.3 | 57.9 | 66.0 restored |
| Archives | 52.2 | 55.9 | 63.0 restored |
| Reactor | 52.6 | 56.1 | 62.1 restored |
| Exit | 53.3 | 56.4 | 63.8 gate open |

Directional probe: forward +5.2, rear +0.1 raw luminance (4,214 forward and
6,122 rear samples). The visual captures show warm beam cones, teal relay
haloes, brighter powered lamps, and player rim highlights in all five rooms.
Report: `test-results/lighting/report.json`.

The ray-level unit test also checks **every** ray in the fan, not just the
middle one: walls and sealed gates stop the fan, while an open gate passes all
rays to full length. The lighting module is visual-only and does not mutate the
map.

## Statuses and honesty

- **PASS** — the check ran and met its assertion.
- **FAIL** — a real failure; the process exits nonzero.
- **WARN** — the check ran but evidence was inconclusive (for example no visible
  flashlight frame change). Warnings are not passes.
- **SKIP** — the check was deliberately skipped by a flag or an environment
  capability (for example headless Chromium not reporting a coarse pointer).
- **BLOCKED** — a prerequisite was absent (usually the engine bundle/HUD never
  mounted). Blocked checks are not passes.

Missing gameplay produces blocked checks and exit 1, never a green CI result.

## Verified integration run

On 2026-10-31, the existing production standalone build was copied to a
temporary directory with its static assets and tested on `127.0.0.1:3107` with
blank `TINKER_API_KEY` and `TINKER_MODEL_PATH`. No rebuild was run while the
shared build was in use. Local Chrome reported **27 PASS, 0 FAIL, 0 WARN,
0 SKIP, 0 BLOCKED**. All director requests in the browser run were mocked;
the report shows only `127.0.0.1:3107` requests. Report:
`test-results/smoke/2026-10-31T15-41-58-872Z/report.json` (local, git-ignored).

The same checkout passed **56 unit tests**, `npm run typecheck`, and
`npm run test:lighting` (**14 deterministic scenes plus a directional beam
probe**). Local validation used Node 25.4.0; the deployment targets Node 24 LTS,
which was not separately exercised here.

A separate request to the same isolated standalone `/api/director`, with empty
Tinker configuration, returned HTTP 200, `source: fallback`,
`reason: missing_api_key`, and `Cache-Control: no-store`. The earlier
integration run also confirmed a foreign Origin returns HTTP 403. No paid model
calls or training ran.

## Diagnostics

- Default directory: `test-results/smoke/<timestamp>/` (already git-ignored).
- `report.json` — results, options, per-suite console/page errors, director
  requests, sampled scene evidence, Chrome path.
- Lighting captures: `test-results/lighting/<room>-<mode>.png` and
  `test-results/lighting/report.json` (git-ignored).
- `summary.txt` — one line per result.
- Screenshots: `desktop-playing.png`, `desktop-final.png`, `touch-narrow.png`,
  and one image per director scenario.
- Failure details include the wait that timed out and the sampled evidence used
  for the decision.

## Known limitations

- **Canvas heuristics.** Pixel and frame-delta checks are smoke signals, not
  visual regressions. Background animation means a frame delta alone cannot
  prove movement; room and stamina evidence are accepted alongside it.
- **Flashlight.** State is exposed in the HUD and touch button. Beam visibility
  uses local pixel samples, not a full visual regression. A real state toggle
  with inconclusive visible lighting still warns rather than passing. In the
  verified run the whole-frame mean change was 0.0, while the local grid showed
  a peak +18 across 7 lit cells; the deterministic directional probe is the
  stronger beam signal.
- **Lighting stills.** The deterministic scenes use a fixed camera, seed, and
  time. They cover room scale, beam direction, relay haloes, and the powered
  exit, but not animation, every prop, or shadow popping. Grain is random per
  run, so thresholds keep margin; the captures still need a human look for art
  quality.
- **Audio.** Web Audio is not asserted. Headless Chrome is launched with
  `--mute-audio`; the harness verifies the UI stays error-free, not that cues
  sound correct.
- **Cleanup.** Listener stability is checked on `window` within one page.
  Full audio-context teardown at component unmount is not observable from the
  DOM; navigating/reloading is checked for errors only.
- **Input timing.** Movement and pause settle times are bounded but generous.
  Very slow machines may warn on movement/flashlight; rerun before treating a
  warning as a defect.
- **No debug state mutation / cheats.** The browser smoke harness only uses
  visible controls, keyboard input, and semantic roles. It cannot warp to
  relays, force endings, or inspect engine internals. Relay/ending/death paths
  are not reached by this short run; they need either a longer deterministic
  playthrough or engine-level tests. The lighting fixtures build a detached
  `World` inside the isolated page and never touch the running app.
- **Touch emulation.** Headless Chromium may report `(pointer: fine)` even with
  `hasTouch`; in that case touch checks skip with a clear reason. A real mobile
  browser or headed run can confirm.
- **Server-side director behavior.** Mocked responses bypass the real API.
  Input/output schema enforcement, rate limiting, and Tinker fallback are unit
  tested in `tests/director*.test.ts`.
- **Timing scenario cost.** The timeout check adds roughly 10 seconds by design.
  Use `--skip-slow` for a quicker pass.

## Suggested integration checks

```bash
# backend unit tests + types + deterministic lighting
npm test
npm run typecheck
npm run test:lighting

# terminal 1: production build, then keep the app running
npm run build
npm start

# terminal 2
node scripts/smoke.mjs http://localhost:3000

# quick pass without the 9s timeout scenario
node scripts/smoke.mjs http://localhost:3000 --skip-slow
```
