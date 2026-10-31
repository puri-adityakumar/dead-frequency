# Dead Frequency blog draft

A local DEV article draft for the Hacktoberfest Open-Source AI Challenge,
Week 4: Ghost in the Machine. It has not been published or submitted.

- [`dead-frequency-ghost-in-the-machine.md`](dead-frequency-ghost-in-the-machine.md):
  the article, with `published: false` and relative local asset paths.
- `assets/`: delivered screenshots, recordings, cover, and architecture diagram.
  See [`assets/media-notes.md`](assets/media-notes.md) for capture details.

The draft is intentionally honest about the shipped state: the game runs on a
scripted fallback, no live Tinker request or training has happened, and there is
no public release, hosted demo, deployment, or chosen app license yet. The code
and complete media package are in the private repository
[puri-adityakumar/dead-frequency](https://github.com/puri-adityakumar/dead-frequency).
The reviewed draft is about 2,100 words, including frontmatter.

## Asset manifest

| Path | Use in the article | Status |
| --- | --- | --- |
| `assets/banner.png` | Frontmatter cover image | Delivered, 1200x630 |
| `assets/screenshots/01-title.png` | Title screen after the intro | Delivered, 2560x1600 |
| `assets/screenshots/02-gameplay.png` | Gameplay scene | Delivered, 2560x1600 |
| `assets/screenshots/03-flashlight.png` | Flashlight on | Delivered, 2560x1600 |
| `assets/screenshots/04-fallback.png` | Fallback label in the radio feed | Delivered, 2560x1600 |
| `assets/screenshots/05-pause.png` | Pause overlay in the comparison table | Delivered, 2560x1600 |
| `assets/screenshots/06-mobile.png` | Narrow-screen touch controls | Delivered, 1170x2532 |
| `assets/video/dead-frequency-demo.mp4` | Local narrated demo | Delivered, 46.4 s, 1280x720, H.264/AAC |
| `assets/video/dead-frequency-demo-poster.png` | Video poster | Delivered, 1280x720 |
| `assets/video/narration.txt` | Narration transcript and disclosure | Delivered, Microsoft Edge Andrew Neural voice |
| `assets/video/dead-frequency-demo.srt` | English sidecar captions | Delivered, sixteen sentence-level cues |
| `assets/video/lighting-demo.mp4` | Silent isolated-fixture comparison | Delivered, 12 s, 1280x720, not gameplay |
| `assets/diagrams/architecture.png` | Illustrative source map | Delivered, 1600x1000, not a runtime trace |
| `assets/media-notes.md` | Capture method and coverage limits | Delivered |

The gameplay clip uses real controls and restores one relay. Director requests
are mocked as fallback. Narration uses Microsoft Edge's online
`en-US-AndrewNeural` voice. There is no music, drone, synthetic background bed,
or captured game audio. The footage is unchanged by this audio revision. No full playthrough,
creature contact, death, ending, or mobile recording is claimed.

## Placeholder and fact checklist

| Item | Current state | Before publishing |
| --- | --- | --- |
| Repository URL | Real private repository linked in the Code section. | Make the code accessible to readers only when a public release is authorized; a private link is not public evidence. |
| Cover image | Relative `assets/banner.png`. | Replace with an absolute raw URL or upload the image to DEV. DEV usually cannot resolve a relative cover path. |
| Inline images | Relative `assets/...` paths; local references pass the package check. | Replace with raw URLs or DEV-hosted uploads. |
| Demo video | Verified local 46.4-second `.mp4` with poster, transcript, and captions. | For DEV, upload to a supported host and use a `{% embed ... %}` block or a public link. A repository-relative MP4 is not an inline DEV player. |
| Browser QA | 27 post-lighting Chrome checks pass with no failures, warnings, skips, or blocked checks. | Preserve the distinction between browser smoke and a completed playthrough. See `docs/QA.md` for the report. |
| Media facts | Exact duration, narration source, mocked director, and coverage limits documented. | Preserve the distinction between gameplay and isolated lighting fixtures. |
| License | No app license chosen. The article says the app is not yet licensed open source. | Add a `LICENSE` file before calling the app open source. |
| Hosted demo | None. The article says so. | Keep the local-only wording unless a real deployment exists. |
| Live inference and training | None. Zero Tinker checkpoints. | Keep the scripted-fallback wording. Do not claim a live model, fine-tune, or held-out evaluation. |
| Dark Sector reference | Concept attribution only. No app code copied. Reference excluded from Git. | Keep the attribution and the no-redistribution caveat. |
| Secrets and PII | Delivered images and sampled video frames reviewed; no visible credentials, personal paths, or browser profile UI found. Not an exhaustive every-frame audit. | Recheck any edited or newly captured media before upload. |
| AI-at-the-core requirement | OpenCode was used during development; the runtime director is still scripted fallback. | Explain that distinction. Do not claim a live open-weight game director or assume the coding workflow alone establishes challenge eligibility. |

## Claim guardrails

Use these exact positions unless new evidence lands:

- **Scripted fallback, not live AI.** The shipped game makes no model calls.
  Every haunting event is deterministic fallback copy, labelled `FALLBACK`.
- **No Tinker fine-tune.** The account had zero checkpoints. No training, no
  paid inference, no baseline-versus-tuned evaluation. Do not claim the Tinker
  fine-tuning category.
- **No Render deployment.** `render.yaml` is a blueprint, not a deployment. Do
  not claim the Render category.
- **Private repo, no license.** The repository link is real but not public.
  Do not call the app open source until a license file exists. A public URL
  alone is not a license.
- **Tests are split.** 56 unit tests, TypeScript, production build, fourteen
  deterministic lighting scenes, a directional beam probe, and 27 post-lighting
  Chrome smoke checks are verified. The browser run has no failures or warnings.
- **Simulation coverage is not a full playthrough.** Relays, death, and both
  endings have engine-level tests. The short browser demo did not reach all of
  them.
- **Open components are not open weights.** Next.js, React, TypeScript, Node,
  Zod, and Playwright are open-source components. Tinker is a hosted inference
  service. The repository contains an adapter and contract, not model weights.
- **Attribution is not permission.** The supplied Dark Sector reference informed
  the concept. Its code was not copied because the archive has no explicit
  redistribution license, and the reference is excluded from Git.

## Before publishing

1. Re-read the latest `README.md`, `docs/TINKER.md`, and QA notes. Update any
   fact that changed after this draft, especially test and browser counts.
2. Review the delivered media and capture notes. Keep accurate captions if any
   clip is replaced, trimmed, or re-recorded. Run `npm run test:blog` after edits.
3. Ensure the linked repository is public when publication is authorized.
   Replace relative asset paths with publicly accessible raw URLs or DEV
   uploads. Private GitHub raw URLs are not a substitute for public media.
   Set `cover_image` to an absolute URL.
4. On DEV, add the four tags exactly: `devchallenge`, `hf26challenge`,
   `gamedev`, `opensource`. Keep `published: false` until the final review.
5. If the video is uploaded to YouTube or Vimeo, replace the Markdown image link
   with DEV's `{% embed <video URL> %}` syntax so it plays inline.
6. Run the final checks: `npm test`, `npm run typecheck`, `npm run build`, and
   `npm run test:lighting`. For the browser suite, start the app and run
   `node scripts/smoke.mjs <local URL>`; do not point it at Tinker.
7. Search the article and media for secrets, tokens, personal paths, and
   unverified claims. Confirm the article never says `live` when it means
   fallback.
8. Add the license file if the repository will be presented as open source.
9. Submit only the partner categories actually earned. The draft currently
   claims none.
10. Check the challenge deadline: October 31, 2026 at 11:59 PM PDT
    (November 1 at 12:29 PM IST). Note any later code changes in the project
    README. Writing this draft does not publish or submit an entry.

## Local package check

Run `npm run test:blog`. The check
validates unpublished frontmatter, required tags and sections, every embedded
local asset, PNG headers/dimensions, and the MP4 header. It prints remaining
publication reminders separately. Passing it means the local package is intact,
not that the project is deployed, eligible for a category, or submitted.

## Preview notes

Relative paths work in a local Markdown preview or on GitHub once `blogs/` and
`blogs/assets/` are committed together. DEV does not resolve repository-relative
image paths, so the published version needs absolute URLs or DEV-hosted media.
The article links to the challenge page and the real private repository. Neither
the repository link nor private raw-media links make the draft publicly usable.
