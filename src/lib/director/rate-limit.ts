import {
  LIVE_REQUEST_COOLDOWN_MS,
  MAX_INFLIGHT_REQUESTS,
  RATE_LIMIT_MAX_KEYS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from './constants';

export interface RateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window, in-process limiter with a hard cap on tracked keys. The key cap
 * prevents a spoofed header or many distinct clients from growing memory
 * without bound. This is best-effort abuse reduction, not authentication.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = clampInt(
      options.maxRequests ?? RATE_LIMIT_MAX_REQUESTS,
      1,
      10_000,
    );
    this.windowMs = clampInt(options.windowMs ?? RATE_LIMIT_WINDOW_MS, 1, 3_600_000);
    this.maxKeys = clampInt(options.maxKeys ?? RATE_LIMIT_MAX_KEYS, 1, 100_000);
  }

  allow(key: string, now: number = Date.now()): boolean {
    const safeKey = key.length > 0 ? key.slice(0, 128) : 'unknown';
    const bucket = this.buckets.get(safeKey);

    if (bucket && bucket.resetAt > now) {
      if (bucket.count >= this.maxRequests) return false;
      bucket.count += 1;
      return true;
    }

    if (bucket) this.buckets.delete(safeKey);
    if (this.buckets.size >= this.maxKeys) this.makeRoom(now);

    this.buckets.set(safeKey, {
      count: 1,
      resetAt: now + this.windowMs,
    });
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private makeRoom(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

/**
 * Bounds concurrent live inference and adds a short cooldown between live
 * attempts. Busy requests use the deterministic fallback instead of queueing,
 * so a burst cannot multiply paid upstream calls.
 */
export class InflightGate {
  private readonly maxConcurrent: number;
  private readonly cooldownMs: number;
  private active = 0;
  private lastReleasedAt: number | null = null;

  constructor(options: { maxConcurrent?: number; cooldownMs?: number } = {}) {
    this.maxConcurrent = clampInt(
      options.maxConcurrent ?? MAX_INFLIGHT_REQUESTS,
      1,
      32,
    );
    this.cooldownMs = clampInt(options.cooldownMs ?? LIVE_REQUEST_COOLDOWN_MS, 0, 60_000);
  }

  tryAcquire(now: number = Date.now()): boolean {
    if (this.active >= this.maxConcurrent) return false;
    if (this.lastReleasedAt !== null && now - this.lastReleasedAt < this.cooldownMs) {
      return false;
    }
    this.active += 1;
    return true;
  }

  release(now: number = Date.now()): void {
    this.active = Math.max(0, this.active - 1);
    this.lastReleasedAt = now;
  }

  get activeCount(): number {
    return this.active;
  }
}

const SAFE_CLIENT_KEY = /^[0-9A-Za-z:._-]{1,64}$/;

/**
 * Best-effort client identity for rate limiting. Proxy headers can be spoofed,
 * so the global gate remains the hard bound on upstream work.
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Bound the scanned prefix as well as the accepted key length; proxy
    // headers are attacker-controlled and can be arbitrarily large.
    const first = forwardedFor.slice(0, 256).split(',')[0]?.trim() ?? '';
    if (first.length <= 64 && SAFE_CLIENT_KEY.test(first)) return first;
  }

  const realIp = headers.get('x-real-ip')?.trim() ?? '';
  if (realIp.length <= 64 && SAFE_CLIENT_KEY.test(realIp)) return realIp;

  return 'unknown';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
