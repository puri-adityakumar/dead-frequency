import type { DirectorResponse, DirectorState } from '../../shared/contracts';
import {
  LIVE_RATE_LIMIT_MAX_REQUESTS,
  LIVE_REQUEST_COOLDOWN_MS,
  MAX_INFLIGHT_REQUESTS,
  MAX_MODEL_CONTENT_CHARS,
  MAX_OUTPUT_TOKENS,
  MAX_UPSTREAM_RESPONSE_BYTES,
  RATE_LIMIT_WINDOW_MS,
  UPSTREAM_TIMEOUT_MS,
} from './constants';
import {
  readDirectorConfig,
  TINKER_CHAT_COMPLETIONS_URL,
  type EnvRecord,
  type TinkerConfig,
} from './config';
import {
  fallbackResponse,
  SAFE_FALLBACK_STATE,
  type FallbackReason,
} from './fallback';
import { toDirectorEvent } from './policy';
import { buildDirectorMessages } from './prompt';
import { InflightGate, RateLimiter } from './rate-limit';
import {
  directorResponseSchema,
  directorStateSchema,
  modelDecisionSchema,
  normalizeOperatorMessage,
  type ModelDecision,
} from './schema';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DirectorServiceOptions {
  env: EnvRecord;
  fetchImpl?: FetchLike;
  /** Omit for a default bounded gate; pass null only in isolated tests. */
  gate?: InflightGate | null;
  /** Omit for the default process-wide live-attempt budget. */
  liveLimiter?: RateLimiter;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxOutputTokens?: number;
}

export interface DirectorService {
  respond(state: DirectorState): Promise<DirectorResponse>;
}

interface UpstreamOptions {
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
}

type UpstreamResult =
  | { ok: true; decision: ModelDecision }
  | { ok: false; reason: FallbackReason };

type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' };

export function createDirectorService(
  options: DirectorServiceOptions,
): DirectorService {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const gate =
    options.gate === undefined
      ? new InflightGate({
          maxConcurrent: MAX_INFLIGHT_REQUESTS,
          cooldownMs: LIVE_REQUEST_COOLDOWN_MS,
        })
      : options.gate;
  const liveLimiter =
    options.liveLimiter ??
    new RateLimiter({
      maxRequests: LIVE_RATE_LIMIT_MAX_REQUESTS,
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxKeys: 1,
    });
  const now = options.now ?? Date.now;
  const timeoutMs = clampInt(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS, 50, 30_000);
  const maxResponseBytes = clampInt(
    options.maxResponseBytes ?? MAX_UPSTREAM_RESPONSE_BYTES,
    256,
    1024 * 1024,
  );
  const maxOutputTokens = clampInt(options.maxOutputTokens ?? MAX_OUTPUT_TOKENS, 16, 512);

  return {
    async respond(state: DirectorState): Promise<DirectorResponse> {
      const parsedState = directorStateSchema.safeParse(state);
      if (!parsedState.success) {
        return fallbackResponse(SAFE_FALLBACK_STATE, 'invalid_state');
      }
      const safeState = parsedState.data;

      const configResult = readDirectorConfig(options.env);
      if (!configResult.ok) {
        return fallbackResponse(safeState, configResult.reason);
      }

      const attemptAt = now();
      if (gate && !gate.tryAcquire(attemptAt)) {
        return fallbackResponse(safeState, 'busy');
      }

      // Separate window budget on top of the concurrency gate. Rotating client
      // keys or waiting out the short cooldown cannot multiply paid attempts.
      if (!liveLimiter.allow('live', attemptAt)) {
        gate?.release(attemptAt);
        return fallbackResponse(safeState, 'busy');
      }

      try {
        const upstream = await requestUpstream(safeState, configResult.config, {
          fetchImpl,
          timeoutMs,
          maxResponseBytes,
          maxOutputTokens,
        });
        if (!upstream.ok) {
          return fallbackResponse(safeState, upstream.reason);
        }

        const candidate: DirectorResponse = {
          source: 'live',
          event: toDirectorEvent(safeState, upstream.decision),
        };
        const validated = directorResponseSchema.safeParse(candidate);
        if (!validated.success) {
          return fallbackResponse(safeState, 'internal_fallback');
        }
        return validated.data;
      } catch {
        // No error detail is returned: it could contain upstream text or headers.
        return fallbackResponse(safeState, 'internal_fallback');
      } finally {
        gate?.release(now());
      }
    },
  };
}

async function requestUpstream(
  state: DirectorState,
  config: TinkerConfig,
  options: UpstreamOptions,
): Promise<UpstreamResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // The deadline races the whole operation, not just the fetch promise. A
  // response whose headers arrive but whose body stalls still resolves to a
  // prompt fallback, even if the fetch implementation ignores the abort.
  const deadline = new Promise<UpstreamResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ ok: false, reason: 'upstream_timeout' });
    }, options.timeoutMs);
  });

  const work = requestUpstreamOnce(
    state,
    config,
    options,
    controller.signal,
  ).catch(
    (error: unknown): UpstreamResult => ({
      ok: false,
      reason:
        timedOut || isAbortError(error) ? 'upstream_timeout' : 'upstream_error',
    }),
  );

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function requestUpstreamOnce(
  state: DirectorState,
  config: TinkerConfig,
  options: UpstreamOptions,
  signal: AbortSignal,
): Promise<UpstreamResult> {
  const response = await options.fetchImpl(TINKER_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelPath,
      messages: buildDirectorMessages(state),
      temperature: 0.6,
      max_tokens: options.maxOutputTokens,
      stream: false,
    }),
    cache: 'no-store',
    redirect: 'error',
    signal,
  });

  if (!response.ok) {
    await cancelBody(response);
    return { ok: false, reason: 'upstream_error' };
  }

  const read = await readBoundedResponseText(response, options.maxResponseBytes);
  if (!read.ok) return { ok: false, reason: 'upstream_too_large' };

  let payload: unknown;
  try {
    payload = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: 'invalid_upstream_response' };
  }

  const content = extractChatContent(payload);
  if (content === null) {
    return { ok: false, reason: 'invalid_upstream_response' };
  }

  const decision = parseModelDecision(content);
  if (!decision) {
    return { ok: false, reason: 'invalid_model_output' };
  }

  return { ok: true, decision };
}

async function cancelBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Draining a rejected response body is best-effort only.
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<BodyReadResult> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    return { ok: false, reason: 'too_large' };
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: true, text };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored by an abort.
        }
        return { ok: false, reason: 'too_large' };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }

    text += decoder.decode();
    return { ok: true, text };
  } catch (error) {
    // Release the stream on decode errors and unexpected read failures.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored by an abort.
    }
    throw error;
  }
}

export function extractChatContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const choice = choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;

  const content = choice.message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join('');
  }

  return null;
}

export function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        if (candidate.length > MAX_MODEL_CONTENT_CHARS) return null;
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

export function parseModelDecision(content: string): ModelDecision | null {
  if (content.length > MAX_MODEL_CONTENT_CHARS) return null;

  const parsed = extractFirstJsonObject(content);
  if (!isRecord(parsed)) return null;

  // Preserve unknown keys so the strict schema rejects them.
  const candidate = {
    ...parsed,
    message: normalizeOperatorMessage(parsed.message),
  };
  const result = modelDecisionSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
