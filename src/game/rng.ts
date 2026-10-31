/**
 * Deterministic PRNG + integer hash helpers.
 * Pure module: no DOM, no Math.random. Everything here is reproducible from a seed,
 * which keeps the whole simulation reproducible under the fixed-step loop.
 */

export interface RNG {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  intExclusive(min: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
  chance(p: number): boolean;
}

export function mulberry32(seed: number): RNG {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    intExclusive: (min, maxExclusive) => {
      if (maxExclusive <= min) return min;
      return Math.floor(min + next() * (maxExclusive - min));
    },
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp as (typeof items)[number];
      }
      return items;
    },
    chance: (p) => next() < p,
  };
}

/**
 * Stateless 2D hash → [0,1). Used for per-tile decoration so visuals can be
 * regenerated per frame without consuming the seeded RNG stream.
 */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Time-sequence hash for flicker/scanline animation that must not touch the sim RNG. */
export function hash1(t: number, seed = 0): number {
  return hash2(Math.floor(t * 7), Math.floor(t * 3), seed);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
