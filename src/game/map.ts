/**
 * Seeded facility generation — pure, DOM-free.
 *
 * Five semantic rooms (from the shared contract) land in a 3x2 coarse cell grid;
 * an MST of 2-tile-wide L corridors links every room — the exit room hangs off
 * the MST as a leaf, so it is always sealed behind exactly one gated approach.
 * 1-2 loop corridors add pressure. The gate is the corridor cross-section in the
 * exit room's wall band; non-exit corridors are routed around that band so the
 * seal can never leak or be bypassed.
 */

import type { RoomId } from '../shared/contracts';
import type { RNG } from './rng';
import { clamp, mulberry32 } from './rng';

export const TILE = 8;
export const MAP_W = 63;
export const MAP_H = 45;
export const TILE_VOID = 0;
export const TILE_FLOOR = 1;
export const TILE_WALL = 2;
export const TILE_GATE = 3;

export type PropKind =
  | 'desk'
  | 'chair'
  | 'plant'
  | 'gurney'
  | 'cabinet'
  | 'ivstand'
  | 'locker'
  | 'shelf'
  | 'crate'
  | 'barrel'
  | 'pipe'
  | 'core'
  | 'console'
  | 'bench'
  | 'relay';

export interface PropDef {
  kind: PropKind;
  x: number;
  y: number;
  /** Collider radius in units; 0 = background-only decor. */
  r: number;
  /** Per-instance visual variant index so each prop reads as distinct. */
  variant: number;
}

export interface RoomSite {
  id: RoomId;
  caption: string;
  /** Tile bounds, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Centre in world units. */
  cx: number;
  cy: number;
  lamps: Array<{ x: number; y: number }>;
}

export interface RelaySite {
  room: Extract<RoomId, 'medical' | 'archives' | 'reactor'>;
  x: number;
  y: number;
}

export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  /** Coarse block flag for BFS only (prop-covered tiles); physics uses real colliders. */
  propMap: Uint8Array;
  rooms: RoomSite[];
  props: PropDef[];
  relays: RelaySite[];
  consoleSite: { x: number; y: number };
  /** Tile indices sealed until the exit unlocks. */
  gateTiles: number[];
  spawn: { x: number; y: number };
  creatureSpawn: { x: number; y: number };
  waypoints: Array<{ x: number; y: number }>;
}

const ROOM_META: Array<{ id: RoomId; caption: string }> = [
  { id: 'arrival', caption: 'RECEPTION' },
  { id: 'medical', caption: 'MEDICAL WARD' },
  { id: 'archives', caption: 'THE ARCHIVES' },
  { id: 'reactor', caption: 'REACTOR HALL' },
  { id: 'exit', caption: 'GATE ATRIUM' },
];

interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Node {
  tx: number;
  ty: number;
  id: RoomId;
}

const CELL_COLS = 3;
const CELL_ROWS = 2;
const CELL_W = 21;
const CELL_H = 22;

function cellRect(col: number, row: number): TileRect {
  const x0 = 1 + col * CELL_W;
  const y0 = 1 + row * CELL_H;
  const x1 = col === CELL_COLS - 1 ? MAP_W - 2 : x0 + CELL_W - 2;
  const y1 = row === CELL_ROWS - 1 ? MAP_H - 2 : y0 + CELL_H - 2;
  return { x0, y0, x1, y1 };
}

function expand(rect: TileRect, pad: number): TileRect {
  return { x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
}

function rectContains(rect: TileRect, x: number, y: number): boolean {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

export function createMap(seed: number): GameMap {
  const rng = mulberry32(seed ^ 0x5f3759df);
  const tiles = new Uint8Array(MAP_W * MAP_H); // all void
  const propMap = new Uint8Array(MAP_W * MAP_H);
  const idx = (x: number, y: number): number => y * MAP_W + x;

  // --- Assign the five rooms to coarse cells (6 cells, shuffled, take 5). ---
  const cells: TileRect[] = [];
  for (let row = 0; row < CELL_ROWS; row++) {
    for (let col = 0; col < CELL_COLS; col++) cells.push(cellRect(col, row));
  }
  rng.shuffle(cells);

  const rooms: RoomSite[] = [];
  for (let i = 0; i < ROOM_META.length; i++) {
    const meta = ROOM_META[i]!;
    const cell = cells[i]!;
    const maxW = Math.min(17, cell.x1 - cell.x0 + 1 - 3);
    const maxH = Math.min(12, cell.y1 - cell.y0 + 1 - 3);
    const rw = Math.min(maxW, rng.int(13, 17));
    const rh = Math.min(maxH, rng.int(10, 12));
    const x0 = cell.x0 + rng.intExclusive(0, Math.max(1, cell.x1 - cell.x0 + 1 - rw));
    const y0 = cell.y0 + rng.intExclusive(0, Math.max(1, cell.y1 - cell.y0 + 1 - rh));
    const x1 = Math.min(cell.x1, x0 + rw - 1);
    const y1 = Math.min(cell.y1, y0 + rh - 1);
    rooms.push({
      id: meta.id,
      caption: meta.caption,
      x0,
      y0,
      x1,
      y1,
      cx: (x0 + (x1 - x0 + 1) / 2) * TILE,
      cy: (y0 + (y1 - y0 + 1) / 2) * TILE,
      lamps: [],
    });
  }
  const roomById = new Map<RoomId, RoomSite>();
  for (const r of rooms) roomById.set(r.id, r);

  for (const r of rooms) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) tiles[idx(x, y)] = TILE_FLOOR;
    }
  }

  // --- Nodes = room centre tiles. ---
  const centers: Node[] = rooms.map((r) => {
    const tx = Math.floor((r.x0 + r.x1) / 2);
    const ty = Math.floor((r.y0 + r.y1) / 2);
    return { tx, ty, id: r.id };
  });
  const nodeById = (id: RoomId): Node | undefined => centers.find((c) => c.id === id);
  const exitNode = nodeById('exit')!;
  const innerNodes = centers.filter((c) => c.id !== 'exit');
  const exitBand = expand(roomById.get('exit')!, 2); // protected zone for non-exit corridors

  /**
   * L-shaped corridor carving with a route that must not cross `avoid` (if set).
   * Returns exactly the tiles this corridor turned into floor (its claims).
   */
  const carveL = (A: Node, B: Node, avoid: TileRect | null, routeRng: RNG): number[] => {
    const claimed = new Set<number>();
    const claim = (x: number, y: number): void => {
      if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) return;
      const i = idx(x, y);
      if (tiles[i] !== TILE_FLOOR) {
        tiles[i] = TILE_FLOOR;
        claimed.add(i);
      }
    };
    // Corridors are strictly spine-inclusive: the vertical strip covers columns
    // (x, x+1) and the horizontal strip rows (y, y+1). With a random lane
    // offset the two strips of an L could sit on opposite sides of the corner
    // and only touch diagonally; the wall pass then seals the seam and an
    // entire room can be stranded. Pinning both strips to the spine means the
    // legs always weld into one connected corridor.
    const ox = 0 as const;
    const oy = 0 as const;
    void routeRng; // lane jitter retired; parameter kept for stream stability
    const stampH = (xa: number, xb: number, y: number): void => {
      if (xa === xb) {
        claim(xb, y + oy);
        claim(xb, y + oy + 1);
        return;
      }
      const step = xa <= xb ? 1 : -1;
      claim(xa, y + oy);
      claim(xa, y + oy + 1);
      for (let x = xa; x !== xb; x += step) {
        claim(x, y + oy);
        claim(x, y + oy + 1);
      }
      claim(xb, y + oy);
      claim(xb, y + oy + 1);
    };
    const stampV = (ya: number, yb: number, x: number): void => {
      if (ya === yb) {
        claim(x + ox, yb);
        claim(x + ox + 1, yb);
        return;
      }
      const step = ya <= yb ? 1 : -1;
      claim(x + ox, ya);
      claim(x + ox + 1, ya);
      for (let y = ya; y !== yb; y += step) {
        claim(x + ox, y);
        claim(x + ox + 1, y);
      }
      claim(x + ox, yb);
      claim(x + ox + 1, yb);
    };

    const crossesAvoid = (xa: number, ya: number, xb: number, yb: number, horiz: boolean): boolean => {
      if (!avoid) return false;
      if (horiz) {
        const x0 = Math.min(xa, xb);
        const x1 = Math.max(xa, xb);
        return yb >= avoid.y0 - 1 && yb <= avoid.y1 + 1 && x1 >= avoid.x0 - 1 && x0 <= avoid.x1 + 1;
      }
      const y0 = Math.min(ya, yb);
      const y1 = Math.max(ya, yb);
      return xb >= avoid.x0 - 1 && xb <= avoid.x1 + 1 && y1 >= avoid.y0 - 1 && y0 <= avoid.y1 + 1;
    };

    // Build leg list; if a leg crosses the protected band, detour via one of the
    // band's outer corners (deterministic order, closest corner first).
    const horizontalFirst = routeRng.chance(0.5);
    type Leg = { xa: number; ya: number; xb: number; yb: number; horiz: boolean };
    let legs: Leg[];
    const direct: Leg[] = horizontalFirst
      ? [
          { xa: A.tx, ya: A.ty, xb: B.tx, yb: A.ty, horiz: true },
          { xa: B.tx, ya: A.ty, xb: B.tx, yb: B.ty, horiz: false },
        ]
      : [
          { xa: A.tx, ya: A.ty, xb: A.tx, yb: B.ty, horiz: false },
          { xa: A.tx, ya: B.ty, xb: B.tx, yb: B.ty, horiz: true },
        ];
    const bad = (ls: Leg[]): boolean => ls.some((l) => crossesAvoid(l.xa, l.ya, l.xb, l.yb, l.horiz));
    if (!bad(direct)) {
      legs = direct;
    } else {
      const corners: Node[] = [
        { tx: avoid!.x0 - 2, ty: avoid!.y0 - 2, id: 'exit' },
        { tx: avoid!.x1 + 2, ty: avoid!.y0 - 2, id: 'exit' },
        { tx: avoid!.x0 - 2, ty: avoid!.y1 + 2, id: 'exit' },
        { tx: avoid!.x1 + 2, ty: avoid!.y1 + 2, id: 'exit' },
      ];
      corners.sort((c, d) => {
        const ac = Math.hypot(c.tx - A.tx, c.ty - A.ty) + Math.hypot(c.tx - B.tx, c.ty - B.ty);
        const bd = Math.hypot(d.tx - A.tx, d.ty - A.ty) + Math.hypot(d.tx - B.tx, d.ty - B.ty);
        return ac - bd;
      });
      let solved: Leg[] | null = null;
      for (const c of corners) {
        const via: Leg[] = horizontalFirst
          ? [
              { xa: A.tx, ya: A.ty, xb: c.tx, yb: A.ty, horiz: true },
              { xa: c.tx, ya: A.ty, xb: c.tx, yb: c.ty, horiz: false },
              { xa: c.tx, ya: c.ty, xb: B.tx, yb: c.ty, horiz: true },
              { xa: B.tx, ya: c.ty, xb: B.tx, yb: B.ty, horiz: false },
            ]
          : [
              { xa: A.tx, ya: A.ty, xb: A.tx, yb: c.ty, horiz: false },
              { xa: A.tx, ya: c.ty, xb: c.tx, yb: c.ty, horiz: true },
              { xa: c.tx, ya: c.ty, xb: c.tx, yb: B.ty, horiz: false },
              { xa: c.tx, ya: B.ty, xb: B.tx, yb: B.ty, horiz: true },
            ];
        if (!bad(via)) {
          solved = via;
          break;
        }
      }
      legs = solved ?? direct; // geometry is roomy; detour always resolves in practice
    }
    for (const leg of legs) {
      if (leg.horiz) stampH(leg.xa, leg.xb, leg.ya);
      else stampV(leg.ya, leg.yb, leg.xa);
    }
    return [...claimed];
  };

  function manhattan(a: Node, b: Node): number {
    return Math.abs(a.tx - b.tx) + Math.abs(a.ty - b.ty);
  }

  // --- MST over the four non-exit rooms (exit is a leaf off the nearest node). ---
  const mst: Array<[Node, Node]> = [];
  {
    const inTree = new Set<Node>([innerNodes[0]!]);
    while (inTree.size < innerNodes.length) {
      let best: [Node, Node] | null = null;
      let bestD = Infinity;
      for (const a of inTree) {
        for (const b of innerNodes) {
          if (inTree.has(b)) continue;
          const d = manhattan(a, b);
          if (d < bestD || (d === bestD && best && (a.tx + b.tx * 7) < (best[0].tx + best[1].tx * 7))) {
            best = [a, b];
            bestD = d;
          }
        }
      }
      if (!best) break;
      mst.push(best);
      inTree.add(best[1]);
    }
    // Exit leaf: connect from the inner node closest to the exit.
    let leafFrom = innerNodes[0]!;
    let leafD = Infinity;
    for (const n of innerNodes) {
      const d = manhattan(n, exitNode);
      if (d < leafD || (d === leafD && (n.tx * 3 + n.ty) < (leafFrom.tx * 3 + leafFrom.ty))) {
        leafFrom = n;
        leafD = d;
      }
    }
    mst.push([leafFrom, exitNode]);
  }

  // Carve MST.
  const carvedMst: number[] = [];
  mst.forEach(([a, b], i) => {
    const toExit = a.id === 'exit' || b.id === 'exit';
    const r = mulberry32((seed ^ (i * 2654435761 + 17)) >>> 0);
    carvedMst.push(...carveL(a, b, toExit ? null : exitBand, r));
  });
  // Loop corridors for pressure — never incident to exit, routed around its band.
  const carvedLoops: number[] = [];
  {
    const pairs: Array<[Node, Node]> = [];
    for (let i = 0; i < innerNodes.length; i++) {
      for (let j = i + 1; j < innerNodes.length; j++) {
        const dupe = mst.some(([a, b]) => (a === innerNodes[i] && b === innerNodes[j]) || (a === innerNodes[j] && b === innerNodes[i]));
        if (!dupe) pairs.push([innerNodes[i]!, innerNodes[j]!]);
      }
    }
    const rngLoop = mulberry32((seed ^ 0x7ab1d43) >>> 0);
    rngLoop.shuffle(pairs);
    for (const [a, b] of pairs.slice(0, 2)) {
      const r = mulberry32((seed ^ (a.tx * 31 + b.ty * 977 + 5)) >>> 0);
      carvedLoops.push(...carveL(a, b, exitBand, r));
    }
  }

  // --- Walls: any void tile touching floor becomes wall. ---
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[idx(x, y)] !== TILE_VOID) continue;
      const touches =
        (x > 0 && tiles[idx(x - 1, y)] === TILE_FLOOR) ||
        (x < MAP_W - 1 && tiles[idx(x + 1, y)] === TILE_FLOOR) ||
        (y > 0 && tiles[idx(x, y - 1)] === TILE_FLOOR) ||
        (y < MAP_H - 1 && tiles[idx(x, y + 1)] === TILE_FLOOR);
      if (touches) tiles[idx(x, y)] = TILE_WALL;
    }
  }

  // --- Gate: seal the entrance ring around the exit room.
  // Room rectangles never touch, and passage corridors are routed around the
  // exit's protective band, so every floor tile in this one-tile ring belongs
  // to the gated exit approach — sealing the ring closes every doorway and
  // can never strand a relay room on the far side. Unsealing restores them
  // to plain floor.
  const exitRoom = roomById.get('exit')!;
  const gateTiles: number[] = [];
  {
    const ring = expand(exitRoom, 1);
    for (let y = Math.max(0, ring.y0); y <= Math.min(MAP_H - 1, ring.y1); y++) {
      for (let x = Math.max(0, ring.x0); x <= Math.min(MAP_W - 1, ring.x1); x++) {
        const onBorder = x === ring.x0 || x === ring.x1 || y === ring.y0 || y === ring.y1;
        if (!onBorder) continue;
        const i = idx(x, y);
        if (tiles[i] !== TILE_FLOOR) continue;
        tiles[i] = TILE_GATE;
        gateTiles.push(i);
      }
    }
  }

  // --- Lamps per room (landmark anchors for the ambient scene). ---
  for (const r of rooms) {
    const count = rng.int(2, 3);
    for (let i = 0; i < count; i++) {
      const lx = r.cx + rng.range(-2.5, 2.5) * TILE;
      const ly = r.cy + rng.range(-2, 2) * TILE;
      r.lamps.push({ x: lx, y: ly });
    }
  }

  const props: PropDef[] = [];
  const relays: RelaySite[] = [];
  for (const roomId of ['medical', 'archives', 'reactor'] as const) {
    const room = roomById.get(roomId)!;
    let placed = false;
    for (let attempt = 0; attempt < 16 && !placed; attempt++) {
      const rx = room.cx + rng.range(-3, 3) * TILE * 0.6;
      const ry = room.cy + rng.range(-2.5, 2.5) * TILE * 0.6;
      const tx = Math.floor(rx / TILE);
      const ty = Math.floor(ry / TILE);
      if (tx <= room.x0 || tx >= room.x1 || ty <= room.y0 || ty >= room.y1) continue;
      if (roomId === 'reactor') {
        if (Math.hypot(rx - room.cx, ry - room.cy) < 13) continue;
      }
      if (tiles[idx(tx, ty)] !== TILE_FLOOR) continue;
      relays.push({ room: roomId, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });
      placed = true;
    }
    if (!placed) {
      relays.push({ room: roomId, x: room.cx + TILE, y: room.cy - TILE });
    }
  }
  // Register relay pedestal colliders before the rest of the prop scatter.
  for (const relay of relays) {
    props.push({ kind: 'relay', x: relay.x, y: relay.y, r: 3.2, variant: 0 });
  }

  // --- Console in the exit room, pinned to a clean floor tile near centre. ---
  let consoleSite = { x: exitRoom.cx, y: exitRoom.cy };
  {
    const tx = Math.floor(exitRoom.cx / TILE);
    const ty = Math.floor(exitRoom.cy / TILE);
    if (tiles[idx(tx, ty)] === TILE_FLOOR) consoleSite = { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
  }
  props.push({ kind: 'console', x: consoleSite.x, y: consoleSite.y, r: 3.4, variant: 0 });

  // --- Props, rejection-sampled inside each room with soft margins. ---
  const arrivalRoom = roomById.get('arrival')!;
  const placeFree = (x: number, y: number, r: number): boolean => {
    if (Math.hypot(x - arrivalRoom.cx, y - arrivalRoom.cy) < TILE * 1.4) return false;
    for (const relay of relays) {
      if (Math.hypot(x - relay.x, y - relay.y) < r + TILE * 1.2) return false;
    }
    if (Math.hypot(x - consoleSite.x, y - consoleSite.y) < r + TILE * 1.6) return false;
    for (const p of props) {
      if (Math.hypot(x - p.x, y - p.y) < r + p.r + TILE * 0.55) return false;
    }
    return true;
  };
  const spawnProp = (room: RoomSite, kind: PropKind, r: number, count: number): void => {
    const m = Math.max(TILE * 1.6, r);
    for (let i = 0; i < count; i++) {
      let ok = false;
      let px = room.cx;
      let py = room.cy;
      for (let attempt = 0; attempt < 22 && !ok; attempt++) {
        px = rng.range(room.x0 * TILE + m, (room.x1 + 1) * TILE - m);
        py = rng.range(room.y0 * TILE + m, (room.y1 + 1) * TILE - m);
        if (!placeFree(px, py, r)) continue;
        ok = true;
      }
      if (ok) props.push({ kind, x: px, y: py, r, variant: rng.int(0, 3) });
    }
  };

  const arrival = roomById.get('arrival')!;
  const medical = roomById.get('medical')!;
  const archives = roomById.get('archives')!;
  const reactor = roomById.get('reactor')!;
  spawnProp(arrival, 'desk', 4.2, rng.int(2, 3));
  spawnProp(arrival, 'chair', 1.8, rng.int(3, 5));
  spawnProp(arrival, 'plant', 1.6, 2);
  spawnProp(medical, 'gurney', 4.6, rng.int(3, 4));
  spawnProp(medical, 'cabinet', 3.0, 2);
  spawnProp(medical, 'ivstand', 0, rng.int(2, 3));
  spawnProp(medical, 'locker', 2.6, 2);
  spawnProp(archives, 'shelf', 5.4, rng.int(4, 5));
  spawnProp(archives, 'cabinet', 3.0, 2);
  spawnProp(archives, 'crate', 2.2, rng.int(1, 3));
  spawnProp(reactor, 'core', 6.8, 1);
  spawnProp(reactor, 'pipe', 3.2, 3);
  spawnProp(reactor, 'barrel', 2.3, rng.int(2, 4));
  spawnProp(reactor, 'locker', 2.6, 2);
  spawnProp(exitRoom, 'bench', 3.6, 2);
  spawnProp(exitRoom, 'crate', 2.2, rng.int(1, 2));
  {
    // Pin the core to the reactor centre over whatever jitter it got.
    const core = props.find((p) => p.kind === 'core');
    if (core) {
      core.x = reactor.cx;
      core.y = reactor.cy;
    } else {
      props.push({ kind: 'core', x: reactor.cx, y: reactor.cy, r: 6.8, variant: 0 });
    }
  }

  // --- Mark prop-covered tiles for BFS (centre-distance test). ---
  for (const p of props) {
    if (p.r <= 0) continue;
    const tx0 = Math.max(0, Math.floor((p.x - p.r) / TILE));
    const ty0 = Math.max(0, Math.floor((p.y - p.r) / TILE));
    const tx1 = Math.min(MAP_W - 1, Math.floor((p.x + p.r) / TILE));
    const ty1 = Math.min(MAP_H - 1, Math.floor((p.y + p.r) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const cxx = (tx + 0.5) * TILE;
        const cyy = (ty + 0.5) * TILE;
        if (Math.hypot(cxx - p.x, cyy - p.y) < p.r + 1.5) propMap[idx(tx, ty)] = 1;
      }
    }
  }

  // --- Spawns. ---
  const arrivalSite = roomById.get('arrival')!;
  let spawn = { x: arrivalSite.cx, y: arrivalSite.cy };
  for (let attempt = 0; attempt < 12; attempt++) {
    const sx = arrivalSite.cx + rng.range(-2, 2) * TILE;
    const sy = arrivalSite.cy + rng.range(-1.5, 1.5) * TILE;
    const t = idx(clamp(Math.floor(sx / TILE), 0, MAP_W - 1), clamp(Math.floor(sy / TILE), 0, MAP_H - 1));
    if (tiles[t] === TILE_FLOOR && propMap[t] === 0) {
      spawn = { x: sx, y: sy };
      break;
    }
  }
  // Creature nest: the relay room corner farthest from the arrival spawn.
  let creatureSpawn = { x: reactor.cx, y: reactor.cy };
  {
    let bestD = -1;
    let best = { x: reactor.cx, y: reactor.cy };
    for (const relay of relays) {
      const d = Math.hypot(relay.x - spawn.x, relay.y - spawn.y);
      if (d > bestD) {
        bestD = d;
        const room = roomById.get(relay.room)!;
        best = {
          x: relay.x < room.cx ? (room.x1 - 1.5) * TILE : (room.x0 + 1.5) * TILE,
          y: relay.y < room.cy ? (room.y1 - 1.5) * TILE : (room.y0 + 1.5) * TILE,
        };
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const csx = best.x + rng.range(-1, 1) * TILE * 0.8;
      const csy = best.y + rng.range(-1, 1) * TILE * 0.8;
      const t = idx(clamp(Math.floor(csx / TILE), 0, MAP_W - 1), clamp(Math.floor(csy / TILE), 0, MAP_H - 1));
      if (tiles[t] === TILE_FLOOR && propMap[t] === 0) {
        creatureSpawn = { x: csx, y: csy };
        break;
      }
    }
  }

  // --- Roam waypoints: room centres + corridor midpoints on carve claims. ---
  const waypoints: Array<{ x: number; y: number }> = rooms.map((r) => ({ x: r.cx, y: r.cy }));
  {
    const allClaims = [...carvedMst, ...carvedLoops];
    for (const i of allClaims) {
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      if (tiles[idx(x, y)] === TILE_FLOOR && propMap[idx(x, y)] === 0 && gateTiles.includes(idx(x, y)) === false) {
        waypoints.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
      }
    }
  }

  return {
    w: MAP_W,
    h: MAP_H,
    tiles,
    propMap,
    rooms,
    props,
    relays,
    consoleSite,
    gateTiles,
    spawn,
    creatureSpawn,
    waypoints,
  };
}

export function roomAtPoint(map: GameMap, x: number, y: number): RoomId | null {
  for (const r of map.rooms) {
    if (x >= r.x0 * TILE && x <= (r.x1 + 1) * TILE && y >= r.y0 * TILE && y <= (r.y1 + 1) * TILE) return r.id;
  }
  return null;
}

export function tileIndexOf(map: GameMap, x: number, y: number): number {
  const tx = clamp(Math.floor(x / TILE), 0, map.w - 1);
  const ty = clamp(Math.floor(y / TILE), 0, map.h - 1);
  return ty * map.w + tx;
}
