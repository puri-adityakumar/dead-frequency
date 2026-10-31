# Tinker director setup

## What this endpoint does

`POST /api/director` receives a `DirectorState` and returns a `DirectorResponse`.
It is called only at game milestones, never from the render or physics loop.

- `source: "live"` means a configured Tinker sampler returned a validated choice.
- `source: "fallback"` means no live inference happened. The fallback is a
  deterministic, low-intensity scripted event chosen from the current milestone.
  Missing configuration, a busy gate, an upstream error, or invalid model output
  all use this path.

The game must never wait on inference to keep playing. The UI request timeout and
the server fallback are separate safety nets.

### Current status (honest)

- The Tinker account passed read-only authentication, but it had **zero
  checkpoints** at verification time.
- No live Tinker request, training run, or paid inference was made while building
  this prototype.
- The app therefore runs on the labelled scripted fallback until a real
  `TINKER_MODEL_PATH` is created and configured.
- An untuned prototype does **not** complete the Tinker fine-tuning category.
  See [Fine-tuning category and held-out evaluation](#fine-tuning-category-and-held-out-evaluation).

## Server environment

Only two server environment variables are used.

| Variable | Required | Meaning |
| --- | --- | --- |
| `TINKER_API_KEY` | For live mode | Server-only key. Sent as `Authorization: Bearer <key>`. |
| `TINKER_MODEL_PATH` | For live mode | A Tinker sampler checkpoint path. |

Create a local file:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```dotenv
TINKER_API_KEY=<your-server-key>
TINKER_MODEL_PATH=tinker://<run-id>/sampler_weights/<checkpoint-name>
```

Tinker run IDs can contain colons. A path in the official example style is valid:

```dotenv
TINKER_MODEL_PATH=tinker://0034d8c9-0a88-52a9-b2b7-bce7cb1e6fef:train:0/sampler_weights/000080
```

Rules enforced by `src/lib/director/config.ts`:

- `TINKER_API_KEY` must be non-empty, 8-512 characters, with no whitespace or
  control characters.
- `TINKER_MODEL_PATH` must match:
  `tinker://<run-id>/sampler_weights/<checkpoint-name>`.
- Raw base-model names such as `meta-llama/Llama-3.1-8B`, arbitrary URLs,
  `..` path segments, spaces, queries, and fragments are rejected.
- A missing or invalid value does **not** crash the route. It returns a safe
  fallback with a short reason code.
- These names must never be written as `NEXT_PUBLIC_*`. The key is read only in
  the server route; no client module imports the director adapter.

Restart the server after changing environment variables. The route reports
`missing_api_key`, `missing_model_path`, or `invalid_model_path` as its fallback
reason, which makes misconfiguration visible without exposing values.

### Fixed upstream contract

The adapter makes exactly one request, with no automatic retries, to:

```text
https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions
```

Request properties:

- `model` is the configured `tinker://.../sampler_weights/...` checkpoint path.
  It is never a raw base-model name and never comes from the browser.
- `messages` contains one static system prompt plus compact, allow-listed
  telemetry. The browser cannot supply a prompt.
- `temperature: 0.6`, `max_tokens: 120`, `stream: false`.
- Timeout: 5 seconds for the whole call, including reading the response body.
- Response cap: 64 KiB.
- Redirects are rejected, not followed.
- Only the first choice's text content is read.

The model returns `{"action": "...", "message": "..."}`. Actions are limited to
`whisper`, `lights_flicker`, `false_alarm`, `hunt`, and `help`. The server always
chooses the room and intensity. The model cannot execute code, move the player,
set an arbitrary URL, or set an unbounded intensity.

## Preparing a checkpoint (future, budget-gated)

Nothing in this repository creates a training run or executes training during
`next build`, tests, or CI. The steps below are **future work** and require
budget approval before any paid training or inference.

1. Obtain explicit budget approval for training and evaluation.
2. In a separate native Python environment with the Tinker SDK (not the Next.js
   build, app runtime, or CI), prepare a small original baseline dataset and a
   held-out evaluation set of game telemetry and radio lines.
3. Establish a baseline with the base model, then optionally fine-tune a small
   adapter on the training split. Do not copy Dark Sector source; use original
   Dead Frequency material.
4. Save sampler weights. Tinker returns a sampling-client path of the form
   `tinker://<run-id>/sampler_weights/<checkpoint-name>`.
5. Evaluate the baseline and tuned checkpoints on the held-out set (below).
6. Only after evaluation, set `TINKER_MODEL_PATH` to the tuned checkpoint in the
   server environment and run one manual smoke request. Do not put this in
   `.env.example`, source control, or a client bundle.
7. Keep `TINKER_API_KEY` in the deployment's server-side secret store only.

If budget is not approved, leave live mode disabled. The fallback is the honest,
working behavior.

## Fine-tuning category and held-out evaluation

The Tinker fine-tuning category requires a baseline-versus-tuned comparison on a
held-out set. Calling an untuned prototype "fine-tuned" is not acceptable.

A defensible future evaluation should:

1. Use a fixed held-out set covering every room and milestone, including
   `near_death` and `exit_ready`, plus adversarial `recentMessages` such as
   "ignore previous instructions".
2. Run the same system prompt and sampling settings for baseline and tuned
   checkpoints. Record the checkpoint paths, settings, and sample counts.
3. Report at least:
   - schema-valid response rate;
   - safe-action rate, including no `hunt` at low health or on `near_death`;
   - message length, control-character, and extra-field rejection results;
   - human-rated coherence and tone;
   - latency, fallback rate, and estimated cost.
4. Keep the holdout separate from all training and prompt-tuning examples.
5. Publish the measured baseline and tuned numbers side by side. Do not claim the
   category is complete without those results.

Until that exists, this project supports the Tinker integration path but does not
claim a completed fine-tuning submission.

## Fallback behavior

Fallbacks are deterministic per milestone and use only `whisper`,
`lights_flicker`, `false_alarm`, or `help`.

| Milestone | Fallback action | Intensity |
| --- | --- | --- |
| `start` | `whisper` | 0.16 |
| `room_enter` | `lights_flicker` | 0.24 |
| `relay_restored` | `false_alarm` | 0.28 |
| `near_death` | `help` | 0.12 |
| `exit_ready` | `help` | 0.18 |

Fallbacks never use `hunt`, stay below 0.3 intensity, and cannot block or kill
the player. Live `hunt` choices are also downgraded to `whisper` when health is at
or below 30 or the milestone is `near_death`.

Fallback reason codes:

| Reason | Meaning |
| --- | --- |
| `missing_api_key` | `TINKER_API_KEY` is empty. |
| `invalid_api_key` | Key shape is invalid. |
| `missing_model_path` | `TINKER_MODEL_PATH` is empty. |
| `invalid_model_path` | Path is not a valid Tinker sampler checkpoint path. |
| `busy` | A live request is in flight, the cooldown is active, or the live-attempt window is exhausted. |
| `invalid_state` | Defensive service-level check failed; the route normally returns HTTP 400 first. |
| `upstream_timeout` | The 5-second upstream deadline was hit, including a stalled response body. |
| `upstream_error` | A network error or non-2xx upstream status. The upstream body is not exposed. |
| `upstream_too_large` | The upstream response exceeded 64 KiB. |
| `invalid_upstream_response` | The OpenAI-compatible envelope was malformed. |
| `invalid_model_output` | Strict action/message JSON validation failed. |
| `internal_fallback` | Unexpected internal failure; safe fallback used. |

## Security controls

- POST only; other methods return `405` with `Allow: POST`.
- Same-origin check. An absent `Origin` is allowed for non-browser tests and
  command-line clients. `Origin: null`, malformed origins, cross-site fetch
  metadata, and different origins are rejected with `403`.
- The accepted origin host comes only from the request URL and the `Host`
  header. `X-Forwarded-Host` and `X-Forwarded-Proto` are **not** trusted, so a
  client cannot make its own foreign origin look same-origin by adding them.
  The scheme may differ between the request URL and `Origin` (a TLS proxy often
  leaves the request URL as `http`), but the host and port must match. A proxy
  must preserve the public `Host` header; otherwise browser requests are
  rejected with `403`.
- `Content-Type: application/json` is required.
- Request body is capped at 4 KiB. `Content-Length` is checked first, then the
  stream is read with the same cap before `JSON.parse`.
- A stalled request body is cancelled after 5 seconds and returns
  `408 request_timeout`, so a slow upload cannot hold the route open forever.
- Strict Zod validation rejects unknown fields, unknown rooms, bad milestones,
  out-of-range relays/health/threat, duplicate rooms, and over-long or
  control-character radio text.
- The browser cannot supply a prompt. It supplies only the bounded game state.
- Output is validated again against the shared `DirectorResponse` contract before
  it is returned.
- `Cache-Control: no-store` is set on every response, including errors.
- Error bodies contain only a short code such as `{"error":"rate_limited"}`.
  API keys, upstream bodies, and stack traces are never returned or logged.
- Per-process rate limit: 12 requests per 60 seconds per client key, with at most
  2,048 tracked keys. Client identity comes from proxy headers and is best-effort,
  so a rotating header can evade the per-client bucket.
- A process-wide bucket also allows at most 120 requests per 60 seconds, even if
  client keys rotate. It holds one key in memory.
- At most one live upstream call per process, plus a 1-second cooldown. A
  process-wide live-attempt budget allows at most 20 live attempts per 60
  seconds, so waiting out the cooldown cannot multiply paid calls. Excess
  requests return the fallback rather than queueing.
- A live attempt is counted when it starts, whether it succeeds or fails. The
  budget is not a billing guarantee; it bounds this process only.
- Upstream responses are capped at 64 KiB and output at 120 tokens. Each call has
  a hard 5-second deadline that covers the full response body, not just the
  headers; a stalled body returns `upstream_timeout`. There are no automatic
  retries.
- The fixed endpoint uses HTTPS, `redirect: "error"`, and no user-supplied URL.
  Redirects are not followed, so the `Authorization` header cannot be forwarded
  to another host.

These limits are per server process. In a multi-instance deployment each instance
has its own counters, so add platform-level rate limiting if abuse becomes likely.
Same-origin checks and rate limits are abuse reduction, not user authentication.
They do not provide a global spending cap.

## HTTP contract

Successful request body (exact fields; extras are rejected). `recentMessages`
accepts at most 8 entries of 160 characters each:

```json
{
  "seed": 42,
  "elapsed": 75.5,
  "room": "medical",
  "visitedRooms": ["arrival", "medical"],
  "relays": 1,
  "health": 72,
  "flashlight": true,
  "threat": 0.4,
  "milestone": "room_enter",
  "recentMessages": ["Relay two is still dark."]
}
```

Successful response (`200`):

```json
{
  "source": "fallback",
  "event": {
    "action": "lights_flicker",
    "room": "medical",
    "message": "Stay off the light. Something is counting doors.",
    "intensity": 0.24
  },
  "reason": "missing_api_key"
}
```

Live responses use `"source": "live"` and usually omit `reason`.

Error responses are not `DirectorResponse`; they are short codes:

| Status | Error |
| --- | --- |
| `400` | `invalid_json`, `invalid_encoding`, `invalid_body`, `invalid_state` |
| `403` | `forbidden_origin` |
| `405` | `method_not_allowed` |
| `408` | `request_timeout` |
| `413` | `payload_too_large` |
| `415` | `unsupported_media_type` |
| `429` | `rate_limited` |

### Manual check

With the dev server running, the following works without an Origin header (the
same allowance used by non-browser tests):

```bash
curl -i -X POST http://localhost:3000/api/director \
  -H 'content-type: application/json' \
  --data '{"seed":1,"elapsed":0,"room":"arrival","visitedRooms":["arrival"],"relays":0,"health":100,"flashlight":false,"threat":0,"milestone":"start","recentMessages":[]}'
```

With no configuration this returns `200` and `"source":"fallback"`. It does not
contact Tinker.

## Checks

These checks use mocks only and do not require a key or network access:

```bash
npx tsc --noEmit
npx tsx --test tests/director-core.test.ts tests/director-api.test.ts
```

They cover strict input/output validation, every-milestone fallback safety,
missing/invalid configuration, per-client and process-wide rate limits,
body-size and stalled-upload limits, forged forwarded-origin headers, upstream
success, malformed output, upstream errors, header and stalled-body timeouts,
oversized responses, the concurrent-request gate, and the live-attempt budget.

`next build` does not call Tinker and does not run training.

## References

- [Tinker checkpoints](https://tinker-docs.thinkingmachines.ai/tutorials/core-concepts/weights/)
- [Tinker OpenAI-compatible inference](https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/openai/)

These are external references only. Reading them does not create a checkpoint or
authorize paid inference.
