import test from 'node:test';
import assert from 'node:assert/strict';
import type { DirectorResponse, DirectorState } from '../src/shared/contracts';
import { MAX_REQUEST_BYTES } from '../src/lib/director/constants';
import { TINKER_CHAT_COMPLETIONS_URL } from '../src/lib/director/config';
import {
  createDirectorPostHandler,
  isSameOriginRequest,
} from '../src/lib/director/handler';
import { InflightGate, RateLimiter } from '../src/lib/director/rate-limit';
import { directorResponseSchema } from '../src/lib/director/schema';
import {
  createDirectorService,
  type FetchLike,
} from '../src/lib/director/tinker';

const ENDPOINT = 'http://localhost/api/director';

const ENV = {
  TINKER_API_KEY: 'test-api-key-123',
  TINKER_MODEL_PATH: 'tinker://run-abc/sampler_weights/checkpoint-1',
};

const BASE_STATE: DirectorState = {
  seed: 42,
  elapsed: 75.5,
  room: 'medical',
  visitedRooms: ['arrival', 'medical'],
  relays: 1,
  health: 72,
  flashlight: true,
  threat: 0.4,
  milestone: 'room_enter',
  recentMessages: ['Relay two is still dark.'],
};

function state(overrides: Partial<DirectorState> = {}): DirectorState {
  return { ...BASE_STATE, ...overrides };
}

function completion(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content } }],
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function postRaw(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

function fakeStreamRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return {
    method: 'POST',
    url: ENDPOINT,
    headers: new Headers(headers),
    body: stream,
  } as unknown as Request;
}

async function readJson(response: Response): Promise<{ text: string; body: unknown }> {
  const text = await response.text();
  return { text, body: JSON.parse(text) as unknown };
}

function assertNoStore(response: Response): void {
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('pragma'), 'no-cache');
}

test('missing config returns an honest safe fallback without calling upstream', async () => {
  let calls = 0;
  const handler = createDirectorPostHandler({
    env: {},
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1;
      return completion('{"action":"hunt","message":"It is here."}');
    },
  });

  const response = await handler(post(state()));
  assert.equal(response.status, 200);
  const { text, body } = await readJson(response);
  const director = body as DirectorResponse;

  assert.equal(director.source, 'fallback');
  assert.equal(director.reason, 'missing_api_key');
  assert.equal(director.event.room, 'medical');
  assert.notEqual(director.event.action, 'hunt');
  assert.equal(directorResponseSchema.safeParse(director).success, true);
  assert.equal(calls, 0);
  assert.equal(text.includes('test-api-key'), false);
  assertNoStore(response);
});

test('same-origin requests pass for the request host across schemes', async () => {
  const handler = createDirectorPostHandler({ env: {}, now: () => 1_000 });

  const direct = await handler(post(state(), { origin: 'http://localhost' }));
  assert.equal(direct.status, 200);

  // A TLS-terminating proxy commonly leaves the request URL as http while the
  // browser sends an https Origin. The host still has to match exactly.
  const sameHostHttps = await handler(
    post(state(), {
      origin: 'https://game.example',
      host: 'game.example',
    }),
  );
  assert.equal(sameHostHttps.status, 200);
});

test('forwarded headers cannot vouch for a foreign origin', async () => {
  const handler = createDirectorPostHandler({ env: {}, now: () => 1_000 });

  const spoofed = await handler(
    post(state(), {
      origin: 'https://evil.example',
      host: 'internal:3000',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    }),
  );
  assert.equal(spoofed.status, 403);
  assert.deepEqual((await readJson(spoofed)).body, {
    error: 'forbidden_origin',
  });
  assertNoStore(spoofed);

  assert.equal(
    isSameOriginRequest(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        },
        body: '{}',
      }),
    ),
    false,
  );
});

test('cross-origin and cross-site requests are rejected before inference', async () => {
  let calls = 0;
  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1;
      return completion('{"action":"whisper","message":"Stay low."}');
    },
  });

  const crossOrigin = await handler(
    post(state(), { origin: 'https://evil.example' }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual((await readJson(crossOrigin)).body, { error: 'forbidden_origin' });
  assertNoStore(crossOrigin);

  const crossSite = await handler(post(state(), { 'sec-fetch-site': 'cross-site' }));
  assert.equal(crossSite.status, 403);

  assert.equal(calls, 0);
});

test('origin validation rejects malformed and null origins', () => {
  const withOrigin = (origin: string): Request =>
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { origin },
      body: '{}',
    });

  assert.equal(isSameOriginRequest(new Request(ENDPOINT, { method: 'POST', body: '{}' })), true);
  assert.equal(isSameOriginRequest(withOrigin('http://localhost')), true);
  assert.equal(isSameOriginRequest(withOrigin('http://localhost/')), true);
  assert.equal(isSameOriginRequest(withOrigin('http://localhost/path')), false);
  assert.equal(isSameOriginRequest(withOrigin('http://user:pass@localhost')), false);
  assert.equal(isSameOriginRequest(withOrigin('null')), false);
  assert.equal(isSameOriginRequest(withOrigin('javascript:alert(1)')), false);
  assert.equal(isSameOriginRequest(withOrigin('https://evil.example')), false);

  const withHost = (host: string): Request =>
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { origin: 'https://game.example', host },
      body: '{}',
    });
  assert.equal(isSameOriginRequest(withHost('game.example')), true);
  assert.equal(isSameOriginRequest(withHost('game.example:443')), true);
  assert.equal(isSameOriginRequest(withHost('game.example:8443')), false);
  assert.equal(isSameOriginRequest(withHost('evil.example')), false);
});

function stalledRequest(): Request {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Never enqueue, never close: models a client that stalls its upload.
    },
  });

  return {
    method: 'POST',
    url: ENDPOINT,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: stream,
  } as unknown as Request;
}

test('invalid bodies, content types, and methods return safe no-store errors', async () => {
  const handler = createDirectorPostHandler({ env: {}, now: () => 1_000 });

  const invalidState = await handler(post({ ...state(), room: 'void' }));
  assert.equal(invalidState.status, 400);
  assert.deepEqual((await readJson(invalidState)).body, { error: 'invalid_state' });
  assertNoStore(invalidState);

  const invalidJson = await handler(postRaw('{"seed":'));
  assert.equal(invalidJson.status, 400);
  assert.deepEqual((await readJson(invalidJson)).body, { error: 'invalid_json' });
  assertNoStore(invalidJson);

  const wrongType = await handler(
    postRaw('{}', { 'content-type': 'text/plain' }),
  );
  assert.equal(wrongType.status, 415);
  assert.deepEqual((await readJson(wrongType)).body, {
    error: 'unsupported_media_type',
  });
  assertNoStore(wrongType);

  const wrongMethod = await handler(
    new Request(ENDPOINT, { method: 'GET' }),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.deepEqual((await readJson(wrongMethod)).body, {
    error: 'method_not_allowed',
  });
  assertNoStore(wrongMethod);
});

test('request size limits run before JSON parsing', async () => {
  const handler = createDirectorPostHandler({ env: {}, now: () => 1_000 });

  const declaredTooLarge = await handler(
    fakeStreamRequest('{}', {
      'content-type': 'application/json',
      'content-length': String(MAX_REQUEST_BYTES + 1),
    }),
  );
  assert.equal(declaredTooLarge.status, 413);
  assert.deepEqual((await readJson(declaredTooLarge)).body, {
    error: 'payload_too_large',
  });
  assertNoStore(declaredTooLarge);

  const streamedTooLarge = await handler(
    fakeStreamRequest('x'.repeat(MAX_REQUEST_BYTES + 1), {
      'content-type': 'application/json',
    }),
  );
  assert.equal(streamedTooLarge.status, 413);
  assert.deepEqual((await readJson(streamedTooLarge)).body, {
    error: 'payload_too_large',
  });
});

test('a stalled request body is cut off by the read deadline', async () => {
  const handler = createDirectorPostHandler({
    env: {},
    now: () => 1_000,
    requestBodyTimeoutMs: 20,
  });

  const started = Date.now();
  const response = await handler(stalledRequest());
  const elapsed = Date.now() - started;

  assert.equal(response.status, 408);
  assert.deepEqual((await readJson(response)).body, {
    error: 'request_timeout',
  });
  assert.ok(elapsed < 2_000);
  assertNoStore(response);
});

test('per-client rate limiting rejects bursts and allows another client', async () => {
  const rateLimiter = new RateLimiter({
    maxRequests: 1,
    windowMs: 60_000,
    maxKeys: 10,
  });
  const handler = createDirectorPostHandler({
    env: {},
    now: () => 1_000,
    rateLimiter,
  });

  const first = await handler(post(state()));
  assert.equal(first.status, 200);

  const limited = await handler(post(state()));
  assert.equal(limited.status, 429);
  assert.deepEqual((await readJson(limited)).body, { error: 'rate_limited' });
  assertNoStore(limited);

  const otherClient = await handler(
    post(state(), { 'x-forwarded-for': '203.0.113.9' }),
  );
  assert.equal(otherClient.status, 200);
});

test('the global limiter bounds work when client keys rotate', async () => {
  const globalRateLimiter = new RateLimiter({
    maxRequests: 2,
    windowMs: 60_000,
    maxKeys: 1,
  });
  const handler = createDirectorPostHandler({
    env: {},
    now: () => 1_000,
    globalRateLimiter,
    rateLimiter: new RateLimiter({
      maxRequests: 100,
      windowMs: 60_000,
      maxKeys: 8,
    }),
  });

  const first = await handler(
    post(state(), { 'x-forwarded-for': '203.0.113.1' }),
  );
  const second = await handler(
    post(state(), { 'x-forwarded-for': '203.0.113.2' }),
  );
  const third = await handler(
    post(state(), { 'x-forwarded-for': '203.0.113.3' }),
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.deepEqual((await readJson(third)).body, { error: 'rate_limited' });
  assert.ok(globalRateLimiter.size <= 1);
  assertNoStore(third);
});

test('live response uses the fixed Tinker endpoint and a checkpoint path', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return completion(
      '```json\n{"action":"false_alarm","message":"Relay hums. Keep moving."}\n```',
    );
  };
  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    fetchImpl,
  });

  const response = await handler(
    post(
      state({
        room: 'archives',
        milestone: 'relay_restored',
        relays: 2,
        health: 80,
      }),
    ),
  );
  assert.equal(response.status, 200);
  const { text, body } = await readJson(response);
  const director = body as DirectorResponse;

  assert.equal(director.source, 'live');
  assert.equal(director.event.room, 'archives');
  assert.equal(director.event.action, 'false_alarm');
  assert.equal(directorResponseSchema.safeParse(director).success, true);
  assert.equal(calls.length, 1);
  assert.equal(text.includes(ENV.TINKER_API_KEY), false);
  assert.equal(text.includes(ENV.TINKER_MODEL_PATH), false);
  assertNoStore(response);

  const call = calls[0];
  assert.equal(call.url, TINKER_CHAT_COMPLETIONS_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.cache, 'no-store');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${ENV.TINKER_API_KEY}`);
  assert.equal(headers.get('content-type'), 'application/json');

  const upstreamBody = JSON.parse(String(call.init.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
    stream: boolean;
  };
  assert.equal(upstreamBody.model, ENV.TINKER_MODEL_PATH);
  assert.equal(upstreamBody.messages.length, 2);
  assert.equal(upstreamBody.messages[0]?.role, 'system');
  assert.ok(upstreamBody.messages[1]?.content.includes('archives'));
  assert.ok(upstreamBody.max_tokens <= 120);
  assert.equal(upstreamBody.stream, false);
});

test('malformed upstream bodies and malformed model output fall back safely', async () => {
  const cases: Array<{ label: string; response: () => Response; reason: string }> = [
    {
      label: 'upstream body is not JSON',
      response: () => new Response('not-json', { status: 200 }),
      reason: 'invalid_upstream_response',
    },
    {
      label: 'model content is not JSON',
      response: () => completion('I will now take control.'),
      reason: 'invalid_model_output',
    },
    {
      label: 'model adds a room field',
      response: () =>
        completion('{"action":"whisper","message":"Stay low.","room":"exit"}'),
      reason: 'invalid_model_output',
    },
  ];

  for (const item of cases) {
    const handler = createDirectorPostHandler({
      env: ENV,
      now: () => 1_000,
      fetchImpl: async () => item.response(),
    });
    const response = await handler(post(state()));
    assert.equal(response.status, 200, item.label);
    const { text, body } = await readJson(response);
    const director = body as DirectorResponse;
    assert.equal(director.source, 'fallback', item.label);
    assert.equal(director.reason, item.reason, item.label);
    assert.equal(director.event.room, 'medical', item.label);
    assert.equal(text.includes(ENV.TINKER_API_KEY), false, item.label);
    assertNoStore(response);
  }
});

test('upstream errors fall back once, without leaking the upstream body', async () => {
  let calls = 0;
  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        `provider error ${ENV.TINKER_API_KEY} internal stack trace`,
        { status: 502 },
      );
    },
  });

  const response = await handler(post(state()));
  assert.equal(response.status, 200);
  const { text, body } = await readJson(response);
  const director = body as DirectorResponse;

  assert.equal(director.source, 'fallback');
  assert.equal(director.reason, 'upstream_error');
  assert.equal(calls, 1);
  assert.equal(text.includes(ENV.TINKER_API_KEY), false);
  assert.equal(text.includes('internal stack trace'), false);
});

test('upstream timeouts fall back promptly', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      const abort = (): void => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener('abort', abort, { once: true });
      }
    });

  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    timeoutMs: 25,
    fetchImpl,
  });

  const started = Date.now();
  const response = await handler(post(state()));
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200);
  const { body } = await readJson(response);
  const director = body as DirectorResponse;
  assert.equal(director.source, 'fallback');
  assert.equal(director.reason, 'upstream_timeout');
  assert.ok(elapsed < 2_000);
});

test('a stalled upstream response body is cut off by the deadline', async () => {
  const stalledBody = new ReadableStream<Uint8Array>({
    start() {
      // Headers arrived, but the body never produces another chunk.
    },
  });
  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    timeoutMs: 25,
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: stalledBody,
      }) as unknown as Response,
  });

  const started = Date.now();
  const response = await handler(post(state()));
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200);
  const { body } = await readJson(response);
  const director = body as DirectorResponse;
  assert.equal(director.source, 'fallback');
  assert.equal(director.reason, 'upstream_timeout');
  assert.ok(elapsed < 2_000);
  assertNoStore(response);
});

test('oversized upstream responses fall back instead of buffering forever', async () => {
  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    maxResponseBytes: 300,
    fetchImpl: async () =>
      completion(
        JSON.stringify({
          action: 'whisper',
          message: 'x'.repeat(500),
        }),
      ),
  });

  const response = await handler(post(state()));
  assert.equal(response.status, 200);
  const { body } = await readJson(response);
  const director = body as DirectorResponse;
  assert.equal(director.source, 'fallback');
  assert.equal(director.reason, 'upstream_too_large');
});

test('live hunt is downgraded when the player is near death', async () => {
  const handler = createDirectorPostHandler({
    env: ENV,
    now: () => 1_000,
    fetchImpl: async () => completion('{"action":"hunt","message":"It sees you."}'),
  });

  const response = await handler(
    post(state({ health: 5, milestone: 'near_death', room: 'archives' })),
  );
  const { body } = await readJson(response);
  const director = body as DirectorResponse;

  assert.equal(director.source, 'live');
  assert.equal(director.event.action, 'whisper');
  assert.equal(director.event.room, 'archives');
  assert.ok(director.event.intensity <= 0.3);
});

test('service rejects invalid state and invalid config without crashing', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return completion('{"action":"whisper","message":"Stay low."}');
  };

  const invalidStateService = createDirectorService({ env: {}, gate: null, fetchImpl });
  const invalidState = await invalidStateService.respond({
    ...state(),
    room: 'void',
  } as unknown as DirectorState);
  assert.equal(invalidState.source, 'fallback');
  assert.equal(invalidState.reason, 'invalid_state');
  assert.equal(invalidState.event.room, 'arrival');
  assert.equal(calls, 0);

  const invalidConfigService = createDirectorService({
    env: { TINKER_API_KEY: 'test-api-key-123', TINKER_MODEL_PATH: 'gpt-4o' },
    gate: null,
    fetchImpl,
  });
  const invalidConfig = await invalidConfigService.respond(state());
  assert.equal(invalidConfig.source, 'fallback');
  assert.equal(invalidConfig.reason, 'invalid_model_path');
  assert.equal(calls, 0);
});

test('service busy gate returns fallback without a second upstream call', async () => {
  const gate = new InflightGate({ maxConcurrent: 1, cooldownMs: 0 });
  let release!: (response: Response) => void;
  let calls = 0;

  const fetchImpl: FetchLike = () => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };

  const service = createDirectorService({
    env: ENV,
    fetchImpl,
    gate,
    timeoutMs: 1_000,
  });

  const first = service.respond(state());
  const busy = await service.respond(state());

  assert.equal(busy.source, 'fallback');
  assert.equal(busy.reason, 'busy');
  assert.equal(calls, 1);

  release(completion('{"action":"whisper","message":"Stay low."}'));
  const firstResult = await first;
  assert.equal(firstResult.source, 'live');
  assert.equal(gate.activeCount, 0);
});

test('live inference attempts are capped per process window', async () => {
  let calls = 0;
  const liveLimiter = new RateLimiter({
    maxRequests: 2,
    windowMs: 60_000,
    maxKeys: 1,
  });
  const service = createDirectorService({
    env: ENV,
    gate: null,
    liveLimiter,
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1;
      return completion('{"action":"whisper","message":"Stay low."}');
    },
  });

  const first = await service.respond(state());
  const second = await service.respond(state());
  const third = await service.respond(state());

  assert.equal(first.source, 'live');
  assert.equal(second.source, 'live');
  assert.equal(third.source, 'fallback');
  assert.equal(third.reason, 'busy');
  assert.equal(calls, 2);
});
