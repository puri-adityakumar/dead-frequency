/** Hard limits for the director endpoint. Kept in one place so tests and docs agree. */

export const MAX_REQUEST_BYTES = 4 * 1024;
export const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
export const UPSTREAM_TIMEOUT_MS = 5_000;
export const REQUEST_BODY_TIMEOUT_MS = 5_000;
export const MAX_OUTPUT_TOKENS = 120;
export const MAX_MODEL_CONTENT_CHARS = 8_000;

export const MAX_RECENT_MESSAGES = 8;
export const MAX_RADIO_MESSAGE_CHARS = 160;
export const MAX_OPERATOR_MESSAGE_CHARS = 140;

export const RATE_LIMIT_MAX_REQUESTS = 12;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_KEYS = 2_048;

/**
 * Process-wide request cap. Per-client buckets are keyed by best-effort proxy
 * headers, so a client can rotate them; this cap still bounds total work.
 */
export const GLOBAL_RATE_LIMIT_MAX_REQUESTS = 120;

/** Process-wide live inference attempts per window, independent of the gate. */
export const LIVE_RATE_LIMIT_MAX_REQUESTS = 20;

export const MAX_INFLIGHT_REQUESTS = 1;
export const LIVE_REQUEST_COOLDOWN_MS = 1_000;
