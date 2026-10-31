# Dead Frequency media notes

Status: visual media delivered 2026-10-31; narration revised 2026-11-01. All
visual media comes from the local production build and the game's own Canvas
renderer. Revised narration uses Microsoft's online Edge speech service. No
remote image generation, stock footage, paid inference, or live game-director
model call was used. This audio revision updates the repository media only;
it is not a deployment, DEV publication, or challenge submission.

## Delivered files

| File | Size | Source / scenario |
| --- | --- | --- |
| `banner.png` | 1200x630 PNG | Local HTML/CSS typography over the real `screenshots/02-gameplay.png` frame. No synthetic game art. |
| `screenshots/01-title.png` | 2560x1600 (1280x800 CSS, 2x) | Title overlay over the ambient ready scene. |
| `screenshots/02-gameplay.png` | 2560x1600 | Playing, after walking out of the arrival bay. |
| `screenshots/03-flashlight.png` | 2560x1600 | Flashlight on, beam clipping on the room geometry. |
| `screenshots/04-fallback.png` | 2560x1600 | `Director · fallback` badge and `FALLBACK` radio entry. |
| `screenshots/05-pause.png` | 2560x1600 | Real pause overlay opened with Escape, carrier held. |
| `screenshots/06-mobile.png` | 1170x2532 (390x844 CSS, 3x) | Narrow-screen touch layer, stick held mid-drag, lamp and interact buttons visible. |
| `video/dead-frequency-demo.mp4` | 46.4 s, 6,227,384 bytes | Desktop walkthrough. Unchanged H.264 High, 1280x720, 25 fps, yuv420p; replacement AAC-LC 48 kHz stereo, about 144 kbps actual (192 kbps target); `+faststart`. |
| `video/dead-frequency-demo-poster.png` | 1280x720 PNG | Frame at 00:38.2 of the delivered MP4, with a local HTML play badge and title lockup. |
| `video/lighting-demo.mp4` | 12.0 s, 378,283 bytes | Optional silent before/after lighting clip. H.264 1280x720, 25 fps, no audio track. Three labelled isolated renderer fixtures. Not gameplay. |
| `video/narration.txt` | 1,529 B | Transcript, timestamps, Microsoft voice and online-service disclosure. |
| `video/dead-frequency-demo.srt` | 1,136 B | Sixteen sentence-level English sidecar captions. Not burned in. |
| `diagrams/architecture.png` | 1600x1000 PNG | Local HTML/CSS/SVG source map. Explicitly labelled illustrative, not a runtime trace. |

The six stills are the existing media pass work and were not re-captured. The
current `test-results/capture-demo/capture-report.json` describes the final video
run only; the earlier stills report was overwritten by that run.

## Video scenario list

Times are relative to the delivered MP4.

- 00:00.0 to 00:05.9: title overlay, seed `20261031`, ambient ready scene.
- 00:05.9: `BEGIN TRANSMISSION`; the `start` milestone produces a scripted
  fallback radio line.
- 00:05.9 to 00:30.0: reception. West/east steps and aim sweeps show the HUD,
  radio feed, procedural props, and lighting. The room is a sanctuary, so threat
  stays low.
- 00:31.2: flashlight on, real chip state and Canvas cone. 00:33.0: flashlight
  off for the dark approach.
- 00:34.4: east along the two-tile corridor into the archives.
- 00:37.4: the game's own `RESTORE RELAY` prompt appears; no guessed coordinate
  and no hidden state change.
- 00:37.6: E restores the archives relay. Relay pip 1/3 is on and the
  `relay_restored` fallback line lands in the radio feed.
- 00:38.5: real Escape pause overlay. The clip ends here.

Not shown: the second and third relays, a creature contact or death, the release
or shutdown choice, either ending, or a mobile video. The creature is active in
the archives segment, but the clip does not stage an encounter.

## Optional lighting clip

`video/lighting-demo.mp4` is a silent, labelled comparison, not a gameplay
recording. It shows three isolated renderer fixtures from the deterministic
lighting harness, each as a left/right pair:

- Medical ward, relay restored.
- Reactor hall, lamp off.
- The archives, lamp on.

Every scene carries `BEFORE / EARLIER RAW`, `FINAL / LATEST PASS`, and the
footer `Not gameplay · no player input · no game state changed`. The header says
`Illustrative / isolated renderer fixture`. The clip has no audio track and no
narration; the labels are burned into the picture. It was recorded from local
HTML around the real `test-results/lighting-before/` and
`test-results/lighting-final/` PNGs, then encoded to 12.0 s H.264 at 1280x720.
Final parent review replaced an outdated thirteen-scene footer with the generic
`DETERMINISTIC RENDERER FIXTURES` label. The comparison itself is unchanged; the
final QA suite covers fourteen scenes and a separate directional probe.

## Capture method

- The app was already built and running as a production server on
  `127.0.0.1:3108` (owned by this media workstream). No `npm build` was run and
  `.next` was not edited during capture.
- The user's dev server on `127.0.0.1:3000` and the QA server on `3107` were left
  alone. The capture server on `3108` was stopped after the media pass.
- `node scripts/capture-demo.mjs http://127.0.0.1:3108 --video` drove an isolated
  headless Chrome via `playwright-core` with no saved profile or user session.
- Input was real keyboard and mouse input through the game's controls:
  W/A/S/D, Shift, E, F, Escape, and pointer sweeps. No controller state was
  injected and no debug shortcut was used.
- The recording was a 1280x720, 25 fps VP9 WebM in `test-results/capture-demo/raw/`.
  The original MP4 trimmed the first 2.0 s of page warm-up and encoded with
  `libx264` CRF 20. The audio revision copied that exact video stream and
  replaced only the soundtrack with Microsoft speech.
- Raw video and the local build sources stay in `test-results/`; `blogs/assets/`
  contains only the delivered files.

## Director interception

Every browser `POST /api/director` was intercepted with Playwright
`route.fulfill`. The response was `200` with `source: "fallback"`, the app's
original scripted text, and `reason: "capture_mock_scripted"`. Nothing was
proxied to the route.

- Director requests intercepted: 3 (`start`, `room_enter`, `relay_restored`).
- External-origin requests attempted or blocked: 0.
- Non-POST director requests: 0.
- During gameplay capture: no live Tinker calls, paid inference, uploads, or
  network TTS. Subsequent audio generation sent only the fixed, nonpersonal
  transcript to Microsoft's online Edge speech service.
- The harness allows the same-origin app assets and aborts every other origin.

The Tinker path remains a mocked, unexercised adapter. The video shows only the
scripted fallback path and labels it as fallback in the radio feed.

## Narration, audio, captions

- Voice: Microsoft Edge online neural TTS, `en-US-AndrewNeural`, via `edge-tts`
  7.3.1, rate `+6%`, default pitch and volume. No fallback voice, Azure
  credentials, or paid subscription API was used. This is online synthesis,
  not an offline voice or live game-director inference.
- Eight narration sections, containing sixteen sentences, remain at the
  original scene anchors. First caption: 00:00.630; last speech cue ends at
  00:44.516. Full transcript and anchors are in `video/narration.txt`.
- The original macOS voice and pink-noise/55 Hz background bed were removed.
  The current soundtrack contains speech only: no music, room tone, electronic
  drone, synthetic bed, or captured game audio. The underlying mix is exact
  digital silence between speech; AAC adds only very low-level coding noise.
- `video/dead-frequency-demo.srt` is an optional sidecar caption file. Captions
  are not burned into the picture. Sixteen sentence-level cues use decoded
  speech edges, rather than the old voice's timings.
- Audio check: -16.22 LUFS integrated loudness, -2.00 dBFS decoded peak,
  -2.0 dBTP true peak, zero clipped samples, and gap peak -90.3 dBFS in the
  delivered AAC track. These are automated measurements, not listening approval.
- Reproduction: `scripts/narrate-demo.py` requires explicit `--yes` before
  sending the fixed transcript online. See the root README for dependencies
  and the command. It verifies packet and frame hashes before replacing the
  demo; raw speech and `report.json` remain in ignored `test-results/narration/`.

## Verification performed

- `ffprobe` confirms 46.4 s, H.264 High 1280x720 yuv420p at 25 fps, AAC-LC
  48 kHz stereo, and a fast-start MP4.
- `blackdetect` found no black segment of 0.3 s or longer at the 0.02 threshold.
- `freezedetect` found only intentional static UI: the title overlay near the
  start, and the real pause overlay from 00:38.9 to the end. The simulation is
  paused there, so those pixels are still by design. No gameplay section is
  static.
- The capture report records no page or console errors, `promptFound: true`,
  relay pip count 1, final phase `paused`, and final room `Archives`.
- The stills were inspected visually. `06-mobile.png` visibly contains the touch
  stick and buttons; an earlier metadata race in the stills harness had logged
  `touchLayerVisible: false`, but that report is no longer current.
- Final parent/QA verification reports 56 unit tests, 14 deterministic lighting
  scenes plus a directional beam probe, 27 post-lighting Chrome checks, and a
  passing build/type check. This media pass did not rerun them and changed no
  app, test, README, or article code.
- Parent review confirmed all nine delivered PNG dimensions, both video
  durations, H.264/AAC in the main demo, no audio track in the lighting clip,
  and the original eight caption cues within the 46.4-second runtime. All delivered
  stills and sampled video frames were reviewed for visible credentials,
  personal paths, and browser profile UI; none were found. This was not an
  every-frame audit or a listening test of the narration.
- `npm run test:blog` passes with fourteen local asset references after the
  final article integration. Both capture/check scripts pass `node --check`,
  and `git diff --check` passes. No app code changed during this final review.
- Audio-revision verification: 46.400 seconds and 1,160 frames are preserved.
  Video packet SHA-256 remains
  `390d19c654d927d0b2d839c92d4e13978eb3c5e61d2cd89e92a0ce63c1ff9588`;
  decoded frame SHA-256 also matches. Poster and lighting-video hashes are
  unchanged. Sixteen caption cues are ordered and end within the video. There
  was no listening test. No app source changed, so app tests and build were
  not rerun for this soundtrack-only revision.

## Limitations and remaining issues

- This is a short demo, not a full playthrough. Coverage is one relay, one
  fallback director line set, and the pause overlay.
- The creature is present and active, but no contact, death, or ending is shown.
- The live Tinker path is not demonstrated, because it was never exercised. No
  live AI claim is made in the video or narration.
- The final ~7.9 s is the real pause screen and is intentionally static. If a
  platform rejects a static ending, trim at 00:38.5; the result is shorter than
  the 45 s target.
- The video is 16:9 and the poster is 16:9. The banner is 1200x630 and may be
  cropped by a host's cover slot.
- The optional lighting clip is silent by design and is not a substitute for
  gameplay footage. Its frames are isolated fixtures, not a live playthrough.
- No mobile video was produced. `screenshots/06-mobile.png` is the touch-control
  evidence.
- The article and `blogs/README.md` are parent-owned and still use relative
  `assets/...` paths. DEV may need the media uploaded or rewritten to absolute
  raw URLs.
- No deployment, DEV publication, or challenge submission was performed for
  this audio revision.
