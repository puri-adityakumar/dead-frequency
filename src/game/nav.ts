/**
 * Grid navigation + collision — pure, seed-free, DOM-free.
 * The creature navigates this walkable tile graph (BFS), it never clips walls:
 * movement always resolves through the same circle-vs-world oracle the player uses.
 */

import type { GameMap, PropDef } from './map';
import { TILE, TILE_FLOOR, TILE_GATE, TILE_VOID, TILE_WALL } from './map';
import { clamp } from './rng';

export interface Vec {
  x: number;
  y: number;
}

/** Solid for movement: walls, the void, and sealed gates. */
export function tileSolid(map: GameMap, gateOpen: boolean, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
  const t = map.tiles[ty * map.w + tx];
  if (t === TILE_FLOOR) return false;
  if (t === TILE_GATE) return !gateOpen;
  return true; // void + wall
}

/**
 * Circle-vs-world: sample the circle's centre plus two concentric rings so a
 * body can never rest inside a wall corner, then props (circle colliders).
 */
export function circleBlocked(map: GameMap, gateOpen: boolean, x: number, y: number, r: number): boolean {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tileSolid(map, gateOpen, tx, ty)) return true;
  const rings = [r, r * 0.66];
  for (const ring of rings) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = x + Math.cos(a) * ring;
      const sy = y + Math.sin(a) * ring;
      if (tileSolid(map, gateOpen, Math.floor(sx / TILE), Math.floor(sy / TILE))) return true;
    }
  }
  for (const p of map.props) {
    if (p.r <= 0) continue;
    const dx = x - p.x;
    const dy = y - p.y;
    const rr = r + p.r;
    if (dx * dx + dy * dy < rr * rr) return true;
  }
  return false;
}

/**
 * Axis-separated slide collision. Positions clamp on the axis that hits,
 * leaving the other axis free — the classic "slide along the wall" feel.
 * Returns the resolved position. Never teleports or tunnels: callers pass
 * |d| per sub-step smaller than (TILE - r).
 */
export function moveCircle(
  map: GameMap,
  gateOpen: boolean,
  x: number,
  y: number,
  dx: number,
  dy: number,
  r: number,
): Vec {
  const small = Math.min(Math.abs(dx), Math.abs(dy));
  if (small > TILE - r) {
    // Split into sub-steps to stay tunnel-proof.
    const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / Math.max(0.5, TILE - r));
    let px = x;
    let py = y;
    for (let i = 0; i < n; i++) {
      const at = moveCircle(map, gateOpen, px, py, dx / n, dy / n, r);
      px = at.x;
      py = at.y;
    }
    return { x: px, y: py };
  }
  let nx = x;
  let ny = y;
  if (dx !== 0 && !circleBlocked(map, gateOpen, x + dx, y, r)) nx = x + dx;
  if (dy !== 0 && !circleBlocked(map, gateOpen, x, y + dy, r)) ny = y + dy;
  return { x: nx, y: ny };
}

/**
 * Breadth-first path over the walkable graph. `blocked` marks tiles hostile to
 * BFS (prop-heavy tiles) so the stalked route avoids snagging between props.
 * Neighbour order is fixed (N, E, S, W) so the same query always yields the
 * same route from the same seed state.
 */
export function bfsPath(map: GameMap, gateOpen: boolean, sxw: number, syw: number, gxw: number, gyw: number): Vec[] | null {
  const walkable = (tx: number, ty: number): boolean => {
    if (tileSolid(map, gateOpen, tx, ty)) return false;
    return map.propMap[ty * map.w + tx] === 0;
  };
  let sx = clamp(Math.floor(sxw / TILE), 0, map.w - 1);
  let sy = clamp(Math.floor(syw / TILE), 0, map.h - 1);
  let gx = clamp(Math.floor(gxw / TILE), 0, map.w - 1);
  let gy = clamp(Math.floor(gyw / TILE), 0, map.h - 1);
  // Body or goal may stand somewhere coarse-blocked (interior furniture).
  // Repair that endpoint to its nearest walkable tile: the body stays able to
  // orbit out and BFS always receives a clean pair of endpoints.
  if (!walkable(sx, sy)) {
    const alt = nearestWalkableAround(map, gateOpen, sx, sy);
    if (!alt) return null;
    sx = Math.floor(alt.x / TILE);
    sy = Math.floor(alt.y / TILE);
  }
  if (!walkable(gx, gy)) {
    const alt = nearestWalkableAround(map, gateOpen, gx, gy);
    if (!alt) return null;
    gx = Math.floor(alt.x / TILE);
    gy = Math.floor(alt.y / TILE);
    gxw = alt.x;
    gyw = alt.y;
  }
  if (sx === gx && sy === gy) return [{ x: gxw, y: gyw }];
  const prev = new Int16Array(map.w * map.h).fill(-1);
  prev[sy * map.w + sx] = sy * map.w + sx;
  const queue = new Int32Array(map.w * map.h);
  let head = 0;
  let tail = 0;
  queue[tail++] = sy * map.w + sx;
  const goal = gy * map.w + gx;
  const dirs = [1, -1, map.w, -map.w]; // E, W, S, N — deterministic order
  let found = false;
  while (head < tail) {
    const cur = queue[head++]!;
    if (cur === goal) {
      found = true;
      break;
    }
    const cx = cur % map.w;
    const cy = (cur - cx) / map.w;
    for (let d = 0; d < 4; d++) {
      const n = cur + dirs[d]!;
      if (n < 0 || n >= map.w * map.h) continue;
      const nx = n % map.w;
      const ny = (n - nx) / map.w;
      if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue; // reject wraparound
      if (prev[n] !== -1) continue;
      if (!walkable(nx, ny)) continue;
      prev[n] = cur;
      queue[tail++] = n;
    }
  }
  if (!found) return null;
  const out: Vec[] = [];
  let cur = goal;
  while (cur !== prev[cur]) {
    const cx = cur % map.w;
    const cy = (cur - cx) / map.w;
    out.push({ x: (cx + 0.5) * TILE, y: (cy + 0.5) * TILE });
    cur = prev[cur]!;
  }
  out.reverse();
  return out;
}

/** First walkable tile in a spiral around a point, in world coords. */
export function nearestWalkableAround(map: GameMap, gateOpen: boolean, tx: number, ty: number): Vec | null {
  for (let r = 0; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
        if (tileSolid(map, gateOpen, x, y)) continue;
        if (map.propMap[y * map.w + x] !== 0) continue;
        return { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
      }
    }
  }
  return null;
}

/** True when the straight line between two world points crosses no solid tile. */
export function hasLos(map: GameMap, gateOpen: boolean, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return true;
  const steps = Math.ceil(dist / 3);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sx = ax + dx * t;
    const sy = ay + dy * t;
    if (tileSolid(map, gateOpen, Math.floor(sx / TILE), Math.floor(sy / TILE))) return false;
  }
  return true;
}

/** Flood fill of reachable tile indices for solvability tests. */
export function reachableSet(map: GameMap, gateOpen: boolean, startXw: number, startYw: number): Set<number> {
  const startTx = clamp(Math.floor(startXw / TILE), 0, map.w - 1);
  const startTy = clamp(Math.floor(startYw / TILE), 0, map.h - 1);
  const seen = new Set<number>();
  if (tileSolid(map, gateOpen, startTx, startTy)) return seen;
  const stack: number[] = [startTy * map.w + startTx];
  seen.add(startTy * map.w + startTx);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % map.w;
    const cy = (cur - cx) / map.w;
    const neighbours: Array<[number, number]> = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      if (tileSolid(map, gateOpen, nx, ny)) continue;
      if (map.propMap[ny * map.w + nx] !== 0) continue;
      const idx = ny * map.w + nx;
      if (seen.has(idx)) continue;
      seen.add(idx);
      stack.push(idx);
    }
  }
  return seen;
}

/** Decor-only props carry no collider and are ignored by every callback above. */
export function hasCollider(p: PropDef): boolean {
  return p.r > 0;
}
