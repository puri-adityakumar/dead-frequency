import {
  GLOBAL_RATE_LIMIT_MAX_REQUESTS,
  MAX_REQUEST_BYTES,
  RATE_LIMIT_WINDOW_MS,
  REQUEST_BODY_TIMEOUT_MS,
} from './constants';
import { fallbackResponse } from './fallback';
import {
  clientKeyFromHeaders,
  InflightGate,
  RateLimiter,
} from './rate-limit';
import { directorResponseSchema, directorStateSchema } from './schema';
import { createDirectorService, type FetchLike } from './tinker';

export interface DirectorPostHandlerOptions {
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  gate?: InflightGate | null;
  rateLimiter?: RateLimiter;
  globalRateLimiter?: RateLimiter;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  requestBodyTimeoutMs?: number;
}

type BodyFailure = {
  ok: false;
  status: 400 | 408 | 413;
  error:
    | 'invalid_body'
    | 'invalid_json'
    | 'invalid_encoding'
    | 'payload_too_large'
    | 'request_timeout';
};

type BodyResult = { ok: true; value: unknown } | BodyFailure;

const RESPONSE_HEADERS = {
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  'content-type': 'application/json; charset=utf-8',
  expires: '0',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

const UNSAFE_HEADER_TEXT = /[\s\u0000-\u001F\u007F-\u009F]/;
const SAFE_HOST = /^[A-Za-z0-9.\-:[\]]{1,253}$/;

export function createDirectorPostHandler(
  options: DirectorPostHandlerOptions,
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  const globalRateLimiter =
    options.globalRateLimiter ??
    new RateLimiter({
      maxRequests: GLOBAL_RATE_LIMIT_MAX_REQUESTS,
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxKeys: 1,
    });
  const requestBodyTimeoutMs = clampInt(
    options.requestBodyTimeoutMs ?? REQUEST_BODY_TIMEOUT_MS,
    10,
    30_000,
  );
  const service = createDirectorService({
    env: options.env,
    fetchImpl: options.fetchImpl,
    gate: options.gate,
    now,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  });

  return async (request: Request): Promise<Response> => {
    if (request.method.toUpperCase() !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, {
        allow: 'POST',
      });
    }

    if (!isSameOriginRequest(request)) {
      return jsonResponse({ error: 'forbidden_origin' }, 403);
    }

    // The global bucket runs first so rotating spoofed client headers cannot
    // bypass every request-level limit. It holds exactly one key in memory.
    if (!globalRateLimiter.allow('global', now())) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }

    const limiterKey = clientKeyFromHeaders(request.headers);
    if (!rateLimiter.allow(limiterKey, now())) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }

    if (!isJsonContentType(request.headers.get('content-type'))) {
      return jsonResponse({ error: 'unsupported_media_type' }, 415);
    }

    const body = await readBoundedBody(
      request,
      MAX_REQUEST_BYTES,
      requestBodyTimeoutMs,
    );
    if (!body.ok) {
      return jsonResponse({ error: body.error }, body.status);
    }

    const parsed = directorStateSchema.safeParse(body.value);
    if (!parsed.success) {
      return jsonResponse({ error: 'invalid_state' }, 400);
    }

    let response;
    try {
      response = await service.respond(parsed.data);
    } catch {
      response = fallbackResponse(parsed.data, 'internal_fallback');
    }

    const validated = directorResponseSchema.safeParse(response);
    const safeResponse = validated.success
      ? validated.data
      : fallbackResponse(parsed.data, 'internal_fallback');

    return jsonResponse(safeResponse, 200);
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      ...extraHeaders,
    },
  });
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json';
}

export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;

  const origin = request.headers.get('origin');
  if (origin === null) return true;

  if (
    origin.length > 255 ||
    UNSAFE_HEADER_TEXT.test(origin) ||
    origin.toLowerCase() === 'null'
  ) {
    return false;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  if (
    (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') ||
    originUrl.username.length > 0 ||
    originUrl.password.length > 0 ||
    originUrl.pathname !== '/' ||
    originUrl.search.length > 0 ||
    originUrl.hash.length > 0
  ) {
    return false;
  }

  // Only the request URL and the Host header identify this server. Forwarded
  // host/proto headers are client-supplied and must never make an arbitrary
  // Origin look same-site. A reverse proxy that rewrites Host must be
  // configured to preserve the public Host header.
  const trustedHosts = new Set<string>();

  try {
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') {
      return false;
    }
    if (requestUrl.host.length > 0) {
      trustedHosts.add(requestUrl.host.toLowerCase());
    }
  } catch {
    return false;
  }

  addTrustedHost(trustedHosts, request.headers.get('host'));

  return trustedHosts.has(originUrl.host.toLowerCase());
}

/**
 * Adds both scheme-normalized forms of a host. This makes `:80`/`:443`
 * implicit-port differences harmless while still requiring the same host.
 */
function addTrustedHost(hosts: Set<string>, host: string | null): void {
  if (!host || !SAFE_HOST.test(host)) return;
  for (const scheme of ['http', 'https'] as const) {
    try {
      const url = new URL(`${scheme}://${host}`);
      if (url.hostname.length > 0) hosts.add(url.host.toLowerCase());
    } catch {
      // Invalid Host values are simply not trusted as an allowed origin.
    }
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<BodyResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    if (Number(declaredLength) > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: 'payload_too_large',
      };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, status: 400, error: 'invalid_json' };
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  let timedOut = false;
  const cancelQuietly = (): void => {
    try {
      void reader.cancel().catch(() => {
        // The stream may already be closed or errored.
      });
    } catch {
      // Cancellation is best-effort.
    }
  };
  const timeoutFailure = (): BodyFailure => ({
    ok: false,
    status: 408,
    error: 'request_timeout',
  });
  const timer = setTimeout(() => {
    timedOut = true;
    cancelQuietly();
  }, timeoutMs);

  try {
    while (true) {
      const chunk = await reader.read();
      // A stalled upload that gets cancelled resolves as done; always check
      // the deadline before treating the accumulated bytes as complete.
      if (timedOut) return timeoutFailure();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        cancelQuietly();
        return { ok: false, status: 413, error: 'payload_too_large' };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    if (timedOut) return timeoutFailure();
    cancelQuietly();
    return { ok: false, status: 400, error: 'invalid_encoding' };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) return timeoutFailure();

  if (text.trim().length === 0) {
    return { ok: false, status: 400, error: 'invalid_json' };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
