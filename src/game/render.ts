/**
 * Dead Frequency — Canvas 2.5D renderer.
 *
 * Everything is procedural: painted floors, raised wall faces (top face +
 * front face extruded on screen, row-ordered painter's algorithm), y-sorted
 * props and actors, additive lightmap (warm flashlight / teal relays / red
 * threat), unlit glow pass, fog-vignette, grain. No external assets, no 3D.
 *
 * This module only *reads* the World; it never mutates simulation state.
 */

import type { GameMap, PropDef, RoomSite } from './map';
import { TILE, TILE_FLOOR, TILE_GATE, TILE_WALL } from './map';
import { traceLightCone } from './lighting';
import { clamp, hash1, hash2 } from './rng';
import type { World } from './sim';

const WALL_H = 5.4; // units of visual wall height
const LX = 0.42; // lightmap resolution factor (of CSS pixels)

export interface RenderOpts {
  timeSec: number;
  pointerCss: { x: number; y: number } | null;
  pointerActive: boolean;
}

interface Palette {
  floor: string[];
  floorAlt: string;
  wallTop: string;
  wallTopLip: string;
  wallFace: string;
  wallFaceDark: string;
  trim: string;
}

const CORRIDOR_PALETTE: Palette = {
  floor: ['#343c46', '#303842', '#39414c'],
  floorAlt: '#242c35',
  wallTop: '#505e6c',
  wallTopLip: '#394754',
  wallFace: '#586777',
  wallFaceDark: '#303c48',
  trim: '#798897',
};

const ROOM_PALETTES: Record<string, Palette> = {
  arrival: {
    floor: ['#48535e', '#424d58', '#4e5964'],
    floorAlt: '#303c48',
    wallTop: '#637382',
    wallTopLip: '#475563',
    wallFace: '#708290',
    wallFaceDark: '#3d4b59',
    trim: '#94a7b4',
  },
  medical: {
    floor: ['#3d5350', '#384c4a', '#435b58'],
    floorAlt: '#2b3c39',
    wallTop: '#5d7c72',
    wallTopLip: '#40584f',
    wallFace: '#6b887d',
    wallFaceDark: '#384f46',
    trim: '#8caa9e',
  },
  archives: {
    floor: ['#554b3d', '#4d4437', '#5c5143'],
    floorAlt: '#3b342b',
    wallTop: '#7b6a52',
    wallTopLip: '#574b3c',
    wallFace: '#89765d',
    wallFaceDark: '#4e4437',
    trim: '#ae9672',
  },
  reactor: {
    floor: ['#404d60', '#3a4557', '#465469'],
    floorAlt: '#2b3445',
    wallTop: '#596b8a',
    wallTopLip: '#3f4d65',
    wallFace: '#677d9d',
    wallFaceDark: '#38475d',
    trim: '#8a9ebd',
  },
  exit: {
    floor: ['#3f4d62', '#394659', '#45556b'],
    floorAlt: '#293548',
    wallTop: '#5b708e',
    wallTopLip: '#405169',
    wallFace: '#6b81a0',
    wallFaceDark: '#384a61',
    trim: '#8ba3c2',
  },
};

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private light: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private grain: HTMLCanvasElement | null = null;

  cssW = 0;
  cssH = 0;
  dpr = 1;
  scale = 5;
  camX = 0;
  camY = 0;
  private camInit = false;
  private lastTime = 0;
  private mapRef: GameMap | null = null;
  /** Mask of which props exert a collider — mirrors world map's props. */
  private wallAnimSeed = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Dead Frequency requires a 2D canvas.');
    this.ctx = ctx;
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d') as CanvasRenderingContext2D;
    this.grain = this.makeGrain();
  }

  setCssSize(cssW: number, cssH: number): void {
    const dpr = clamp(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 1, 2);
    const maxPixels = 3800;
    const eff = Math.min(dpr, maxPixels / Math.max(cssW, cssH, 1));
    this.dpr = Math.max(1, eff);
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    this.light.width = Math.max(1, Math.round(cssW * LX));
    this.light.height = Math.max(1, Math.round(cssH * LX));
    // Map tiles are eight world units wide. Keep a room and its exits in view.
    this.scale = clamp(Math.min(cssH / 144, cssW / 210), 2.8, 8);
  }

  /** Reset the smoothed camera so reset()/new seeds snap to the right place. */
  resetCamera(): void {
    this.camInit = false;
  }

  /** Convert CSS pixel coordinates to world units using the last camera. */
  worldFromScreen(cssX: number, cssY: number): { x: number; y: number } {
    return {
      x: (cssX - this.cssW / 2) / this.scale + this.camX,
      y: (cssY - this.cssH / 2) / this.scale + this.camY,
    };
  }

  private makeGrain(): HTMLCanvasElement | null {
    const g = document.createElement('canvas');
    g.width = 128;
    g.height = 128;
    const gctx = g.getContext('2d');
    if (!gctx) return null;
    const img = gctx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const a = Math.floor(Math.random() * 255);
      img.data[i] = a;
      img.data[i + 1] = a;
      img.data[i + 2] = a;
      img.data[i + 3] = 22;
    }
    gctx.putImageData(img, 0, 0);
    return g;
  }

  // ------------------------------------------------------------------ main

  render(w: World, opts: RenderOpts): void {
    const t = opts.timeSec;
    const ready = w.phase === 'ready';
    this.updateCamera(w, t, ready);
    this.lastTime = t;

    const ctx = this.ctx;
    const map = w.map;
    if (this.mapRef !== map) {
      this.mapRef = map;
      this.wallAnimSeed = map.gateTiles.length;
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#07070a';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // camera jitter
    let camX = this.camX;
    let camY = this.camY;
    if (w.shake > 0.001) {
      const s = w.shake * 2.6;
      camX += (hash1(t * 41, 3) - 0.5) * s;
      camY += (hash1(t * 47, 7) - 0.5) * s;
    }
    const s = this.scale;
    const halfW = this.cssW / 2;
    const halfH = this.cssH / 2;
    const wx = (x: number): number => (x - camX) * s + halfW;
    const wy = (y: number): number => (y - camY) * s + halfH;
    this.toX = wx;
    this.toY = wy;

    // visible tile range
    const viewW = halfW / s;
    const viewH = halfH / s;
    const c0 = clamp(Math.floor((camX - viewW) / TILE) - 1, 0, map.w - 1);
    const c1 = clamp(Math.ceil((camX + viewW) / TILE) + 1, 0, map.w - 1);
    const r0 = clamp(Math.floor((camY - viewH - WALL_H) / TILE) - 1, 0, map.h - 1);
    const r1 = clamp(Math.ceil((camY + viewH) / TILE) + 2, 0, map.h - 1);

    this.drawFloor(map, c0, c1, r0, r1, wx, wy, t);
    this.drawRoomTitles(map, wx, wy);
    this.drawHazardRing(map, wx, wy);

    // painter: per row — walls, then gate barriers, then drawables (props/actors)
    const drawables: Array<{ key: number; draw: () => void }> = [];
    this.collectDrawables(w, t, ready, drawables, c0, c1, r0, r1);
    for (let ty = r0; ty <= r1; ty++) {
      for (let tx = c0; tx <= c1; tx++) {
        const tile = map.tiles[ty * map.w + tx];
        if (tile === TILE_WALL && this.wallOpen(map, tx, ty)) {
          this.drawWallTile(w, map, tx, ty, wx, wy, t);
        }
      }
      for (let tx = c0; tx <= c1; tx++) {
        if (map.tiles[ty * map.w + tx] === TILE_GATE) this.drawGateTile(w, tx, ty, wx, wy, t);
      }
      const rowDrawables = drawables.filter((d) => Math.floor(d.key / TILE) === ty).sort((a, b) => a.key - b.key);
      for (const d of rowDrawables) d.draw();
    }
    // drawables outside the visible row band (safety)
    for (const d of drawables) {
      if (Math.floor(d.key / TILE) < r0 || Math.floor(d.key / TILE) > r1) d.draw();
    }

    // --- light map ---
    this.drawLightmap(w, t, ready, camX, camY);

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.light, 0, 0, this.cssW, this.cssH);
    ctx.restore();

    // --- unlit glows (pierce the dark) ---
    this.drawGlows(w, t, ready, wx, wy);

    // --- screen overlays ---
    this.drawOverlays(w, t, ready);
    this.drawReticle(w, opts);
  }

  private toX!: (x: number) => number;
  private toY!: (y: number) => number;

  private updateCamera(w: World, t: number, ready: boolean): void {
    let targetX: number;
    let targetY: number;
    if (ready) {
      const map = w.map;
      const pts: Array<{ x: number; y: number }> = [{ x: map.spawn.x, y: map.spawn.y }, ...map.rooms.map((r) => ({ x: r.cx, y: r.cy }))];
      const seg = 10;
      const k = Math.floor(t / seg) % pts.length;
      const e = (t % seg) / seg;
      const eased = e * e * (3 - 2 * e);
      const a = pts[k]!;
      const b = pts[(k + 1) % pts.length]!;
      targetX = a.x + (b.x - a.x) * eased;
      targetY = a.y + (b.y - a.y) * eased + Math.sin(t * 0.9) * 2.4;
    } else {
      const p = w.player;
      targetX = p.x + p.aimX * 3.4;
      targetY = p.y + p.aimY * 3.4;
    }
    const vw = this.cssW / 2 / this.scale;
    const vh = this.cssH / 2 / this.scale;
    if (!this.camInit) {
      this.camX = targetX;
      this.camY = targetY;
      this.camInit = true;
    }
    // smooth chase (visual only — outside the sim)
    const dtv = 1 - Math.exp(-Math.max(0, t - this.lastTime) * (ready ? 2.4 : 9));
    this.camX += (targetX - this.camX) * dtv;
    this.camY += (targetY - this.camY) * dtv;
    // clamp into world bounds
    if (w.seed >= 0) {
      const worldW = w.map.w * TILE;
      const worldH = w.map.h * TILE;
      if (worldW > vw * 2) this.camX = clamp(this.camX, vw + 4, worldW - vw - 4);
      else this.camX = worldW / 2;
      if (worldH > vh * 2) this.camY = clamp(this.camY, vh + 4, worldH - vh - 4);
      else this.camY = worldH / 2;
    }
  }

  private wallOpen(map: GameMap, tx: number, ty: number): boolean {
    // draw only wall tiles that touch open space so the void stays invincible
    const n = (dx: number, dy: number): boolean => {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
      const tile = map.tiles[y * map.w + x];
      return tile === TILE_FLOOR || tile === TILE_GATE;
    };
    return n(1, 0) || n(-1, 0) || n(0, 1) || n(0, -1);
  }

  // ------------------------------------------------------------------ floor

  private drawFloor(
    map: GameMap,
    c0: number,
    c1: number,
    r0: number,
    r1: number,
    wx: (x: number) => number,
    wy: (y: number) => number,
    t: number,
  ): void {
    const ctx = this.ctx;
    const s = this.scale;
    for (let ty = r0; ty <= r1; ty++) {
      for (let tx = c0; tx <= c1; tx++) {
        const tile = map.tiles[ty * map.w + tx];
        if (tile !== TILE_FLOOR && tile !== TILE_GATE) continue;
        const room = this.roomAtTile(map, tx, ty);
        const pal = room ? ROOM_PALETTES[room.id] ?? CORRIDOR_PALETTE : CORRIDOR_PALETTE;
        const h = hash2(tx, ty, 11);
        const px = wx(tx * TILE);
        const py = wy(ty * TILE);
        ctx.fillStyle = pal.floor[(h * pal.floor.length) | 0] ?? pal.floor[0]!;
        ctx.fillRect(px, py, s * TILE + 0.6, s * TILE + 0.6);
        // tile seams + grime + glass stains
        if (h > 0.62) {
          ctx.fillStyle = pal.floorAlt;
          ctx.globalAlpha = 0.5 + 0.4 * h;
          ctx.fillRect(px + h * s * 2, py + (1 - h) * s * 2, s * (2.2 + h * 3), s * (1.6 + h * 2));
          ctx.globalAlpha = 1;
        }
        const h2 = hash2(tx, ty, 29);
        if (h2 > 0.88) {
          ctx.fillStyle = 'rgba(10,10,12,0.5)';
          ctx.beginPath();
          ctx.ellipse(px + s * TILE * (0.3 + h2 * 0.4), py + s * TILE * (0.3 + h * 0.4), s * (1.5 + h * 2), s * (1 + h), h2, 0, Math.PI * 2);
          ctx.fill();
        }
        // faint painted walk-line guides in corridors
        if (!room && (tx + ty) % 5 === 0) {
          ctx.fillStyle = 'rgba(200,190,150,0.05)';
          ctx.fillRect(px, py + s * (TILE / 2 - 0.4), s * TILE, s * 0.8);
        }
        if (tile === TILE_GATE) continue;
        // subtle door-sweep shadows under every wall footprint
        if (this.wallBelow(map, tx, ty)) {
          const grad = ctx.createLinearGradient(0, py + s * TILE, 0, py + s * TILE + s * 1.6);
          grad.addColorStop(0, 'rgba(0,0,0,0.4)');
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(px - s * 0.4, py + s * TILE, s * TILE + 0.8, s * 1.6);
          if (hash2(tx, ty, 71) > 0.72) this.glowTick(px + s * 6.4, py + s * TILE + s * 0.4, t, tx, ty);
        }
      }
    }
  }

  private glowTick(px: number, py: number, t: number, tx: number, ty: number): void {
    const ctx = this.ctx;
    const str = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.7 + hash2(tx, ty, 91) * 6.28));
    ctx.fillStyle = `rgba(140,240,220,${(0.12 * str).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, this.scale * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private wallBelow(map: GameMap, tx: number, ty: number): boolean {
    if (ty + 1 >= map.h) return false;
    const tile = map.tiles[(ty + 1) * map.w + tx];
    return tile === TILE_FLOOR || tile === TILE_GATE;
  }

  private roomAtTile(map: GameMap, tx: number, ty: number): RoomSite | null {
    for (const r of map.rooms) {
      if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return r;
    }
    return null;
  }

  private drawRoomTitles(map: GameMap, wx: (x: number) => number, wy: (y: number) => number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const vw = this.cssW / 2 / s;
    const vh = this.cssH / 2 / s;
    for (const r of map.rooms) {
      if (r.cx < this.camX - vw - 60 || r.cx > this.camX + vw + 60) continue;
      if (r.cy < this.camY - vh - 40 || r.cy > this.camY + vh + 40) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(190,200,215,0.13)';
      ctx.font = `700 ${(s * 4.6).toFixed(1)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cy = wy(r.cy - (r.cy - r.y0 * TILE) * 0.22);
      ctx.fillText(r.caption, wx(r.cx), cy);
      ctx.fillStyle = 'rgba(190,200,215,0.09)';
      ctx.font = `500 ${(s * 2.2).toFixed(1)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.fillText(this.roomSub(r.id), wx(r.cx), cy + s * 3.6);
      ctx.restore();
    }
  }

  private roomSub(id: string): string {
    switch (id) {
      case 'arrival':
        return 'SUBLEVEL 3 · INTAKE';
      case 'medical':
        return 'WARD SILENT · TRAYS UNTOUCHED';
      case 'archives':
        return 'COUNT OF RECORDS UNKNOWN';
      case 'reactor':
        return 'CARRIER AT 4% · DO NOT TAP';
      case 'exit':
        return 'AUTHORISED ONLY · SEALED';
      default:
        return '';
    }
  }

  private drawHazardRing(map: GameMap, wx: (x: number) => number, wy: (y: number) => number): void {
    const reactor = map.rooms.find((r) => r.id === 'reactor');
    if (!reactor) return;
    const ctx = this.ctx;
    const s = this.scale;
    const cx = wx(reactor.cx);
    const cy = wy(reactor.cy);
    ctx.save();
    ctx.strokeStyle = 'rgba(220,180,70,0.16)';
    ctx.lineWidth = Math.max(1, s * 0.5);
    ctx.setLineDash([s * 2.2, s * 1.8]);
    for (const r of [11.5, 14.5]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ walls

  private drawWallTile(w: World, map: GameMap, tx: number, ty: number, wx: (x: number) => number, wy: (y: number) => number, t: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const room = this.roomAtTile(map, tx, ty);
    const pal = room ? ROOM_PALETTES[room.id] ?? CORRIDOR_PALETTE : CORRIDOR_PALETTE;
    const px = wx(tx * TILE);
    const py = wy(ty * TILE);
    const g = s * TILE;
    // top face (raised)
    ctx.fillStyle = pal.wallTop;
    ctx.fillRect(px, py - s * WALL_H, g + 0.6, g + 0.6);
    ctx.fillStyle = pal.wallTopLip;
    ctx.fillRect(px + s * 0.8, py - s * WALL_H + s * 0.8, g - s * 1.6, g - s * 1.6);
    // front face: fill the slice of the tile footprint south of the top face
    const frontX = px;
    const frontY = py - s * WALL_H + g;
    ctx.fillStyle = pal.wallFace;
    ctx.fillRect(frontX, frontY, g + 0.6, s * WALL_H + 0.6);
    ctx.fillStyle = pal.wallFaceDark;
    ctx.fillRect(frontX, frontY + s * WALL_H * 0.62, g + 0.6, s * WALL_H * 0.38);
    // baseboard trim on front face
    ctx.fillStyle = pal.trim;
    ctx.fillRect(frontX, frontY + s * WALL_H - s * 0.9, g + 0.6, s * 0.9);

    // per-tile wall scars: pipes, vents, posters, stains
    const h = hash2(tx, ty, 53);
    if (h > 0.68) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(frontX + s * 1.4, frontY + s * (WALL_H * 0.2), s * 1.2, s * WALL_H * 0.55);
    }
    if (h > 0.78 && h < 0.9) {
      ctx.fillStyle = 'rgba(190,200,205,0.14)';
      ctx.fillRect(frontX + s * (1 + h * 3), frontY + s * 0.8, s * 1.8, s * 1.1);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(frontX + s * (1 + h * 3), frontY + s * 0.8, s * 1.8, s * 0.4);
    }
    if (h > 0.94) {
      ctx.fillStyle = 'rgba(160,170,160,0.2)';
      ctx.fillRect(frontX + s * 2, frontY + s * 1.2, s * 3.4, s * 2.2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(frontX + s * 2, frontY + s * 1.2, s * 3.4, s * 0.5);
    }
    // drips
    if (h > 0.34 && h < 0.42) {
      ctx.fillStyle = 'rgba(20,22,22,0.35)';
      ctx.fillRect(frontX + s * 3.6, frontY, s * 0.7, s * WALL_H * 0.8);
    }
    // little wall signage near gate
    if (w.gateOpen === false && this.isGateWall(map, tx, ty)) {
      ctx.fillStyle = 'rgba(230,180,80,0.4)';
      ctx.fillRect(frontX + s * g * 0.42, frontY + s * 1.2, s * g * 0.16, s * 1.6);
    }
  }

  private isGateWall(map: GameMap, tx: number, ty: number): boolean {
    const n = (dx: number, dy: number): boolean => {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
      return map.tiles[y * map.w + x] === TILE_GATE;
    };
    return n(0, 1) || n(1, 0) || n(-1, 0) || n(0, -1);
  }

  // ------------------------------------------------------------------ drawables

  private collectDrawables(
    w: World,
    t: number,
    ready: boolean,
    out: Array<{ key: number; draw: () => void }>,
    c0: number,
    c1: number,
    r0: number,
    r1: number,
  ): void {
    const wx = this.toX;
    const wy = this.toY;
    const s = this.scale;
    const vw = this.cssW / 2 / s + WALL_H;
    const vh = this.cssH / 2 / s + WALL_H;
    // props
    for (const p of w.map.props) {
      if (p.x < this.camX - vw - 20 || p.x > this.camX + vw + 20 || p.y < this.camY - vh - 20 || p.y > this.camY + vh + 20) continue;
      out.push({ key: p.y, draw: () => this.drawProp(p, wx(p.x), wy(p.y), t) });
    }
    // relay pedestals
    for (let i = 0; i < w.relays.length; i++) {
      const r = w.relays[i]!;
      if (r.x < this.camX - vw - 20 || r.x > this.camX + vw + 20 || r.y < this.camY - vh - 20 || r.y > this.camY + vh + 20) continue;
      const done = w.relayDone[i]!;
      const glow = w.relayGlow[i]!;
      out.push({ key: r.y, draw: () => this.drawRelay(wx(r.x), wy(r.y), t, done, glow) });
    }
    // console
    {
      const c = w.map.consoleSite;
      const visibleNow = Math.abs(c.x - this.camX) < vw + 20 && Math.abs(c.y - this.camY) < vh + 20;
      if (visibleNow) out.push({ key: c.y, draw: () => this.drawConsole(wx(c.x), wy(c.y), t, w.gateOpen, w.phase === 'choice') });
    }
    // gate barrier posts/seal visuals — one per gate tile, low-key
    // entities
    if (ready) {
      // ambient scene: draw the dormant creature as a barely-there shape
      out.push({ key: w.creature.y, draw: () => this.drawCreature(w, wx(w.creature.x), wy(w.creature.y), t, true) });
    } else {
      out.push({ key: w.player.y, draw: () => this.drawPlayer(w, wx(w.player.x), wy(w.player.y), t) });
      out.push({ key: w.creature.y, draw: () => this.drawCreature(w, wx(w.creature.x), wy(w.creature.y), t, false) });
    }
  }

  private drawProp(p: PropDef, px: number, py: number, t: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.save();
    // contact shadow
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    ctx.ellipse(px, py, s * (p.r * 0.9 + 1), s * (p.r * 0.5 + 0.6), 0, 0, Math.PI * 2);
    ctx.fill();
    const lift = (sc: number): number => s * sc; // shorthand visual units
    switch (p.kind) {
      case 'desk': {
        const w2 = lift(9), h2 = lift(5.4);
        ctx.fillStyle = '#2e2a24';
        ctx.fillRect(px - w2 / 2, py - h2, w2, h2);
        ctx.fillStyle = '#3a352c';
        ctx.fillRect(px - w2 / 2, py - h2 - lift(1), w2, lift(1.2));
        ctx.fillStyle = '#20201c';
        for (let i = 0; i < 3; i++) ctx.fillRect(px - w2 / 2 + lift(1 + i * 2.6), py - h2 + lift(1.4), lift(0.7), h2 - lift(2.6));
        ctx.fillStyle = 'rgba(120,200,190,0.5)';
        ctx.fillRect(px - lift(1.4), py - h2 - lift(1.8), lift(2.8), lift(0.9));
        break;
      }
      case 'chair': {
        ctx.fillStyle = '#26262a';
        ctx.fillRect(px - lift(1.6), py - lift(2.4), lift(3.2), lift(2.6));
        ctx.fillRect(px - lift(1.6), py - lift(4.6), lift(0.8), lift(2.4));
        break;
      }
      case 'plant': {
        ctx.fillStyle = '#23261e';
        ctx.fillRect(px - lift(1.6), py - lift(2.2), lift(3.2), lift(2.4));
        ctx.strokeStyle = '#2f3a26';
        ctx.lineWidth = Math.max(1, s * 0.4);
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.moveTo(px, py - lift(2.2));
          ctx.quadraticCurveTo(px + lift(Math.cos(i * 2.4) * 2.4), py - lift(4.5), px + lift(Math.cos(i * 2.4) * 3.2), py - lift(5.5));
          ctx.stroke();
        }
        break;
      }
      case 'gurney': {
        const w2 = lift(9.6), h2 = lift(5);
        ctx.fillStyle = '#2a2e30';
        ctx.fillRect(px - w2 / 2, py - h2, w2, h2);
        ctx.fillStyle = (p.variant & 1) === 0 ? '#8f9aa0' : '#9aa49a';
        ctx.globalAlpha = 0.92;
        ctx.fillRect(px - w2 / 2 + lift(0.6), py - h2 - lift(1), w2 - lift(1.2), lift(2.2));
        // sheeted form
        ctx.fillStyle = 'rgba(212,208,196,0.6)';
        ctx.beginPath();
        ctx.ellipse(px - lift(1.6), py - lift(1.4), lift(2.8), lift(1.2), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#575d61';
        ctx.lineWidth = Math.max(1, s * 0.35);
        for (const dx of [-w2 / 2 + lift(1), w2 / 2 - lift(1)]) {
          ctx.beginPath();
          ctx.moveTo(px + dx, py - lift(1.6));
          ctx.lineTo(px + dx, py + lift(0.2));
          ctx.stroke();
        }
        break;
      }
      case 'cabinet': {
        const w2 = lift(5.4), h2 = lift(6.4);
        ctx.fillStyle = '#32353a';
        ctx.fillRect(px - w2 / 2, py - h2, w2, h2);
        ctx.fillStyle = '#3d4147';
        ctx.fillRect(px - w2 / 2, py - h2, w2, lift(1.2));
        ctx.fillStyle = '#23262b';
        for (let i = 0; i < 3; i++) ctx.fillRect(px - w2 / 2 + lift(0.7), py - h2 + lift(1.8 + i * 1.6), w2 - lift(1.4), lift(0.8));
        break;
      }
      case 'ivstand': {
        ctx.strokeStyle = '#565b60';
        ctx.lineWidth = Math.max(1, s * 0.3);
        ctx.beginPath();
        ctx.moveTo(px, py - lift(0.4));
        ctx.lineTo(px, py - lift(7.4));
        ctx.stroke();
        ctx.fillStyle = 'rgba(180,220,210,0.35)';
        ctx.fillRect(px - lift(0.9), py - lift(6.4), lift(1.8), lift(2.4));
        break;
      }
      case 'locker': {
        const w2 = lift(4.4), h2 = lift(8);
        ctx.fillStyle = '#2b3038';
        ctx.fillRect(px - w2 / 2, py - h2, w2, h2);
        ctx.fillStyle = '#1e232a';
        ctx.fillRect(px - w2 / 2 + lift(0.5), py - h2 + lift(0.6), w2 - lift(1), h2 - lift(1.2));
        ctx.fillStyle = '#3f454e';
        ctx.fillRect(px - w2 / 2, py - h2, w2, lift(1.1));
        ctx.fillStyle = 'rgba(220,150,80,0.35)';
        ctx.fillRect(px + w2 / 2 - lift(1.1), py - lift(4.2), lift(0.5), lift(0.9));
        break;
      }
      case 'shelf': {
        const w2 = lift(11), h2 = lift(7.4);
        ctx.fillStyle = '#241f18';
        ctx.fillRect(px - w2 / 2, py - h2, w2, h2);
        ctx.fillStyle = '#2e2820';
        ctx.fillRect(px - w2 / 2, py - h2 - lift(0.9), w2, lift(1));
        for (let row = 0; row < 3; row++) {
          const fy = py - h2 + lift(1 + row * 2.3);
          ctx.fillStyle = '#17140f';
          ctx.fillRect(px - w2 / 2 + lift(0.6), fy, w2 - lift(1.2), lift(1.5));
          for (let i = 0; i < 5; i++) {
            if (hash2(px | 0, row * 5 + i, 17) > 0.55) continue;
            ctx.fillStyle = ['#3a332a', '#453a2c', '#514736'][i % 3] ?? '#3a332a';
            ctx.fillRect(px - w2 / 2 + lift(1 + i * 1.9), fy - lift(0.4), lift(1.5), lift(1.9));
          }
        }
        break;
      }
      case 'crate': {
        const w2 = lift(3.6 + p.variant * 0.4);
        ctx.fillStyle = '#33291d';
        ctx.fillRect(px - w2 / 2, py - w2, w2, w2);
        ctx.strokeStyle = '#4a3c2a';
        ctx.lineWidth = Math.max(1, s * 0.35);
        ctx.strokeRect(px - w2 / 2, py - w2, w2, w2);
        ctx.fillStyle = 'rgba(230,190,110,0.28)';
        ctx.fillRect(px - w2 / 2, py - w2 * 0.62, w2, lift(0.5));
        break;
      }
      case 'barrel': {
        ctx.fillStyle = '#27313a';
        ctx.beginPath();
        ctx.ellipse(px, py - lift(2.6), lift(2.2), lift(2.6), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#313b44';
        ctx.fillRect(px - lift(2.2), py - lift(4.4), lift(4.4), lift(1));
        ctx.fillStyle = 'rgba(220,180,90,0.3)';
        ctx.fillRect(px - lift(2.2), py - lift(3.1), lift(4.4), lift(0.6));
        break;
      }
      case 'pipe': {
        ctx.strokeStyle = '#3a4046';
        ctx.lineWidth = Math.max(2, s * 1.2);
        ctx.beginPath();
        ctx.moveTo(px + lift(-4), py - lift(1));
        ctx.quadraticCurveTo(px, py - lift(5), px + lift(4.5), py - lift(1.6));
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillStyle = '#2c3238';
        ctx.fillRect(px + lift(-1.2), py - lift(3.6), lift(1.2), lift(2));
        break;
      }
      case 'core': {
        const b = 0.16 + 0.2 * Math.abs(Math.sin(t * 1.3));
        ctx.fillStyle = '#1d2027';
        ctx.fillRect(px - lift(9), py - lift(10), lift(18), lift(10));
        ctx.fillStyle = '#262a33';
        ctx.fillRect(px - lift(8), py - lift(10.8), lift(16), lift(11.6));
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = `rgba(120,220,210,${(b + 0.3 - i * 0.06).toFixed(3)})`;
          ctx.fillRect(px - lift(7 + i * 1.4), py - lift(10 - i * 0.6), lift(14 - i * 2.8), lift(0.9));
        }
        ctx.fillStyle = `rgba(130,255,235,${(0.1 + b * 0.5).toFixed(3)})`;
        ctx.fillRect(px - lift(3.4), py - lift(12.6), lift(6.8), lift(3));
        break;
      }
      case 'bench': {
        ctx.fillStyle = '#2b2f36';
        ctx.fillRect(px - lift(6), py - lift(2.6), lift(12), lift(2.2));
        ctx.fillStyle = '#1f2328';
        ctx.fillRect(px - lift(5.4), py - lift(1.2), lift(1.4), lift(1.4));
        ctx.fillRect(px + lift(4), py - lift(1.2), lift(1.4), lift(1.4));
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  private drawRelay(px: number, py: number, t: number, done: boolean, glow: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(px, py, s * 5, s * 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // pedestal
    ctx.fillStyle = '#262b31';
    ctx.fillRect(px - s * 2.6, py - s * 4.4, s * 5.2, s * 4.6);
    ctx.fillStyle = '#31373e';
    ctx.fillRect(px - s * 2.6, py - s * 4.4, s * 5.2, s * 1.1);
    // column + crystal
    ctx.fillStyle = '#1d2226';
    ctx.fillRect(px - s * 1.1, py - s * 9.8, s * 2.2, s * 6);
    if (done) {
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.4);
      ctx.fillStyle = `rgba(120,255,225,${(0.55 + 0.4 * pulse).toFixed(3)})`;
      ctx.fillRect(px - s * 1.7, py - s * 12.4, s * 3.4, s * 3);
      ctx.fillStyle = 'rgba(220,255,245,0.85)';
      ctx.fillRect(px - s * 0.7, py - s * 11.9, s * 1.4, s * 2.1);
      if (glow > 0) {
        ctx.strokeStyle = `rgba(120,255,225,${Math.min(1, glow / 2.2).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, s * 0.5);
        ctx.beginPath();
        ctx.arc(px, py - s * 2, s * (2 + glow * 5), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(120,255,225,0.16)';
      ctx.fillRect(px - s * 4.4, py - s * 13.6, s * 8.8, s * 1.1);
    } else {
      const blink = hash1(t * 2.2, 5) > 0.82 ? 0.8 : 0.24;
      ctx.fillStyle = `rgba(255,90,70,${blink.toFixed(3)})`;
      ctx.fillRect(px - s * 0.9, py - s * 11.6, s * 1.8, s * 1.8);
      ctx.fillStyle = '#151a1d';
      ctx.fillRect(px - s * 1.7, py - s * 12.4, s * 3.4, s * 3);
      ctx.strokeStyle = '#3c4348';
      ctx.lineWidth = Math.max(1, s * 0.28);
      ctx.strokeRect(px - s * 1.7, py - s * 12.4, s * 3.4, s * 3);
    }
    ctx.restore();
  }

  private drawConsole(px: number, py: number, t: number, gateOpen: boolean, choice: boolean): void {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(px, py, s * 6, s * 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#23272e';
    ctx.fillRect(px - s * 6, py - s * 4.6, s * 12, s * 4.8);
    ctx.fillStyle = '#2d323b';
    ctx.fillRect(px - s * 6, py - s * 5.6, s * 12, s * 1.4);
    // monitor bank
    for (let i = 0; i < 3; i++) {
      const mx = px + s * (-4.2 + i * 4.2);
      ctx.fillStyle = '#12161b';
      ctx.fillRect(mx - s * 1.7, py - s * 9.6, s * 3.4, s * 3.4);
      if (choice) {
        ctx.fillStyle = i === 1 ? 'rgba(255,150,70,0.8)' : 'rgba(120,255,225,0.8)';
      } else if (gateOpen) {
        const fl = 0.4 + 0.35 * Math.sin(t * 3 + i * 1.7);
        ctx.fillStyle = `rgba(255,170,80,${fl.toFixed(3)})`;
      } else {
        const b = hash1(t * 1.4, 11 + i) > 0.9 ? 0.5 : 0.08;
        ctx.fillStyle = `rgba(255,80,60,${b.toFixed(3)})`;
      }
      ctx.fillRect(mx - s * 1.3, py - s * 9.2, s * 2.6, s * 2.6);
    }
    if (choice) {
      ctx.fillStyle = 'rgba(255,190,120,0.2)';
      ctx.fillRect(px - s * 12, py - s * 16, s * 24, s * 12);
    }
    ctx.restore();
  }

  private drawGateTile(w: World, tx: number, ty: number, wx: (x: number) => number, wy: (y: number) => number, t: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const px = wx(tx * TILE);
    const py = wy(ty * TILE);
    const g = s * TILE;
    if (w.gateOpen) {
      // side posts + a dim freed light: the seal is gone
      ctx.fillStyle = 'rgba(120,255,225,0.10)';
      ctx.fillRect(px, py - s * WALL_H, g, s * (TILE / 2 + WALL_H));
      ctx.fillStyle = 'rgba(230,180,90,0.35)';
      ctx.fillRect(px, py - s * WALL_H, s * 0.8, s * (TILE / 2 + WALL_H));
      ctx.fillRect(px + g - s * 0.8, py - s * WALL_H, s * 0.8, s * (TILE / 2 + WALL_H));
      return;
    }
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.9));
    ctx.fillStyle = `rgba(255,110,70,${(0.18 + 0.12 * pulse).toFixed(3)})`;
    ctx.fillRect(px, py - s * WALL_H, g, s * (TILE / 2 + WALL_H));
    for (let i = 0; i < 3; i++) {
      const yy = py - s * WALL_H + ((t * 26 + i * 40) % (s * (TILE / 2 + WALL_H)));
      ctx.fillStyle = `rgba(255,170,120,${(0.15 + 0.2 * pulse).toFixed(3)})`;
      ctx.fillRect(px, yy, g, s * 0.7);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(px, py - s * WALL_H, s * 0.8, s * (TILE / 2 + WALL_H));
    ctx.fillRect(px + g - s * 0.8, py - s * WALL_H, s * 0.8, s * (TILE / 2 + WALL_H));
    ctx.fillStyle = 'rgba(255,200,120,0.5)';
    ctx.fillRect(px + g * 0.2, py - s * WALL_H + s * 1.1, g * 0.6, s * 0.7);
  }

  // ------------------------------------------------------------------ actors

  private drawPlayer(w: World, px: number, py: number, t: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const p = w.player;
    const dead = w.phase === 'dead';
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(px, py, s * 2.4, s * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
    if (dead) {
      // lying down
      ctx.fillStyle = 'rgba(120,20,16,0.34)';
      ctx.beginPath();
      ctx.ellipse(px, py, s * 3.4, s * 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#15161a';
      ctx.beginPath();
      ctx.ellipse(px, py - s * 0.6, s * 2.6, s * 1.1, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#22252b';
      ctx.beginPath();
      ctx.arc(px + s * 2.4, py - s * 0.9, s * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    // blink while graced
    const blink = p.iframe > 1.15 && hash1(t * 24, 13) > 0.5;
    if (blink) {
      ctx.globalAlpha = 0.45;
    }
    const moving = Math.hypot(p.vx, p.vy) > 12;
    const bob = moving ? Math.sin(t * 11) * s * 0.28 : Math.sin(t * 2.2) * s * 0.1;
    const bodyTop = py - s * 5.2 + bob;
    // coat
    const grad = ctx.createLinearGradient(0, bodyTop, 0, py);
    grad.addColorStop(0, '#8d9aa4');
    grad.addColorStop(1, '#394653');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px - s * 1.85, py);
    ctx.lineTo(px - s * 2.15, bodyTop + s * 1.6);
    ctx.quadraticCurveTo(px - s * 1.2, bodyTop, px, bodyTop);
    ctx.quadraticCurveTo(px + s * 1.4, bodyTop, px + s * 2.1, bodyTop + s * 1.5);
    ctx.lineTo(px + s * 1.8, py);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(184,224,235,0.75)';
    ctx.lineWidth = Math.max(1, s * 0.16);
    ctx.stroke();
    // Warm beam-side highlight against the cool emergency fill.
    ctx.strokeStyle = 'rgba(255,213,154,0.85)';
    ctx.lineWidth = Math.max(1, s * 0.22);
    ctx.beginPath();
    ctx.moveTo(px + p.aimX * s * 2.1, bodyTop + s * 1.4);
    ctx.lineTo(px + p.aimX * s * 2.35 + p.aimY * s * 0.4, py - s * 0.4);
    ctx.stroke();
    // backpack
    ctx.fillStyle = '#52616c';
    ctx.fillRect(px - s * 1.5 - p.aimX * s * 1.4, bodyTop + s * 0.9, s * 1.3, s * 1.9);
    // head
    // Reflective shoulder tape keeps the player identifiable with the lamp off.
    ctx.fillStyle = '#b5c3bd';
    ctx.fillRect(px - s * 1.45, bodyTop + s * 1.4, s * 2.9, s * 0.38);
    ctx.fillStyle = '#919da6';
    ctx.beginPath();
    ctx.arc(px + p.aimX * s * 0.4, bodyTop - s * 0.9, s * 1.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b1bec5';
    ctx.beginPath();
    ctx.arc(px + p.aimX * s * 0.55, bodyTop - s * 1.15, s * 0.75, 0, Math.PI * 2);
    ctx.fill();
    // flashlight arm
    ctx.strokeStyle = '#667681';
    ctx.lineWidth = Math.max(1.5, s * 0.5);
    ctx.beginPath();
    ctx.moveTo(px + p.aimX * s * 1.1, bodyTop + s * 1.6);
    ctx.lineTo(px + p.aimX * s * 3.1, bodyTop + s * 2.1 + p.aimY * s * 1.2);
    ctx.stroke();
    if (p.flashlight) {
      ctx.fillStyle = 'rgba(255,205,140,0.9)';
      ctx.beginPath();
      ctx.arc(px + p.aimX * s * 3.3, bodyTop + s * 2.1 + p.aimY * s * 1.3, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCreature(w: World, px: number, py: number, t: number, dormant: boolean): void {
    const ctx = this.ctx;
    const s = this.scale;
    const c = w.creature;
    const hunting = c.state === 'hunt';
    const stunned = c.state === 'stunned';
    const sway = Math.sin(c.anim * (hunting ? 9 : 4)) * (dormant ? 0.4 : 1.2);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.ellipse(px, py, s * 3.2, s * 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // tall silhouette
    const grad = ctx.createLinearGradient(0, py - s * 11, 0, py);
    grad.addColorStop(0, hunting ? '#241016' : '#18151c');
    grad.addColorStop(1, '#0b0a0e');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px + sway * s * 0.4, py - s * 10.6);
    ctx.quadraticCurveTo(px - s * 2.6 + sway * s * 0.6, py - s * 6, px - s * 2.1, py);
    ctx.quadraticCurveTo(px, py + s * 0.8, px + s * 2.1, py);
    ctx.quadraticCurveTo(px + s * 2.6 + sway * s * 0.6, py - s * 6, px + sway * s * 0.4 + s * 0.2, py - s * 10.6);
    ctx.closePath();
    ctx.fill();
    // limb threads
    ctx.strokeStyle = hunting ? 'rgba(150,40,40,0.5)' : 'rgba(40,35,45,0.5)';
    ctx.lineWidth = Math.max(1, s * 0.35);
    for (let i = 0; i < 3; i++) {
      const a = sway * 0.1 + Math.sin(c.anim * 5 + i * 2.1) * 0.5;
      ctx.beginPath();
      ctx.moveTo(px, py - s * (7 - i * 2.4));
      ctx.quadraticCurveTo(px + Math.cos(a) * s * 3.4, py - s * (6 - i * 2.2), px + Math.cos(a) * s * 4.4, py - s * (4.4 - i * 2.2));
      ctx.stroke();
    }
    if (stunned) {
      ctx.fillStyle = 'rgba(255,80,60,0.14)';
      ctx.beginPath();
      ctx.arc(px, py - s * 5, s * 5.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ light

  private flickLevel(t: number, seed: number, flicker: boolean): number {
    if (!flicker) return 1;
    return 0.2 + 0.8 * Math.abs(hash1(t * 11, seed) - 0.5) * 2;
  }

  private drawLightmap(w: World, t: number, ready: boolean, camX: number, camY: number): void {
    const lctx = this.lctx;
    const s = this.scale * LX;
    const hw = this.light.width / 2;
    const hh = this.light.height / 2;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.fillStyle = ready ? 'rgb(137,151,171)' : 'rgb(112,128,151)';
    lctx.fillRect(0, 0, this.light.width, this.light.height);
    const lx = (x: number): number => (x - camX) * s + hw;
    const ly = (y: number): number => (y - camY) * s + hh;
    const flicker = w.effects.some((e) => e.kind === 'flicker' && e.until > w.t);
    const hashFlick = flicker ? this.flickLevel(t, 3, true) : 1;

    interface SL {
      x: number;
      y: number;
      r: number;
      c0: string;
      a: number;
      c1?: string;
      wedge?: { dx: number; dy: number; len: number; half: number };
    }
    const lights: SL[] = [];
    const p = w.player;
    // Cool bounce is always present; switching the beam on must never remove it.
    if (!ready) {
      lights.push({ x: p.x, y: p.y - 2, r: 46, c0: 'rgba(192,222,244,0.48)', a: 1, c1: 'rgba(192,222,244,0)' });
      if (p.flashlight) {
        lights.push({
          x: p.x,
          y: p.y,
          r: 0,
          c0: 'rgba(255,196,128,0.72)',
          a: flicker ? hashFlick : 1,
          c1: 'rgba(255,196,128,0)',
          wedge: { dx: p.aimX, dy: p.aimY, len: 116, half: 0.58 },
        });
        lights.push({ x: p.x, y: p.y, r: 30, c0: 'rgba(255,220,175,0.42)', a: flicker ? hashFlick : 1, c1: 'rgba(255,220,175,0)' });
      }
    } else {
      lights.push({ x: w.map.spawn.x, y: w.map.spawn.y, r: 65, c0: 'rgba(120,180,200,0.4)', a: 1, c1: 'rgba(120,180,200,0)' });
    }
    // Emergency fixtures keep silhouettes and doorways readable without the beam.
    for (const room of w.map.rooms) {
      const safe = room.id === 'arrival';
      const powered = safe || (room.id === 'exit' ? w.gateOpen : w.relays.some((r, i) => r.room === room.id && w.relayDone[i]));
      const tint = powered ? '180,225,235' : room.id === 'archives' ? '235,176,112' : room.id === 'reactor' ? '105,205,232' : '142,190,220';
      lights.push({
        x: room.cx, y: room.cy, r: safe ? 108 : 86,
        c0: `rgba(${tint},${powered ? 0.5 : 0.26})`,
        a: 1, c1: `rgba(${tint},0)`,
      });
      room.lamps.forEach((lamp, i) => {
        const pulse = flicker ? this.flickLevel(t, i * 31 + room.x0, true) : 0.97 + 0.03 * Math.sin(t * 1.3 + i);
        lights.push({ x: lamp.x, y: lamp.y - 3, r: powered ? 56 : 42,
          c0: `rgba(${tint},${((powered ? 0.44 : 0.26) * pulse).toFixed(3)})`, a: 1, c1: `rgba(${tint},0)` });
      });
    }
    const reactor = w.map.rooms.find((room) => room.id === 'reactor');
    if (reactor) lights.push({ x: reactor.cx, y: reactor.cy - 8, r: 38,
      c0: 'rgba(90,220,230,0.42)', a: 1, c1: 'rgba(90,220,230,0)' });
    // help-effect corona
    if (w.effects.some((e) => e.kind === 'help' && e.until > w.t) && !ready) {
      lights.push({ x: p.x, y: p.y, r: 13, c0: 'rgba(140,255,190,0.20)', a: 1, c1: 'rgba(140,255,190,0)' });
    }
    // relays + their room lamps
    for (let i = 0; i < w.relays.length; i++) {
      const r = w.relays[i]!;
      const done = w.relayDone[i]!;
      if (done) {
        const pulse = 0.8 + 0.2 * Math.sin(t * 2.2 + i);
        lights.push({ x: r.x, y: r.y, r: 26 * pulse, c0: `rgba(110,255,225,${(0.4 * pulse).toFixed(3)})`, a: 1, c1: 'rgba(110,255,225,0)' });
        const room = w.map.rooms.find((rr) => rr.id === r.room);
        if (room) {
          for (const lamp of room.lamps) {
            const lf = this.flickLevel(t * 0.7 + i * 3, i * 31, flicker);
            lights.push({ x: lamp.x + 0, y: lamp.y, r: 52 * lf, c0: `rgba(190,255,235,${(0.16 * lf * pulse).toFixed(3)})`, a: 1, c1: 'rgba(190,255,235,0)' });
          }
        }
      } else {
        const blink = hash1(t * 1.6, 23 + i) > 0.86 ? 0.22 : 0.05;
        lights.push({ x: r.x, y: r.y, r: 9, c0: `rgba(255,90,70,${blink.toFixed(3)})`, a: 1, c1: 'rgba(255,90,70,0)' });
      }
    }
    // console
    {
      const c = w.map.consoleSite;
      if (w.gateOpen) {
        const pulse = 0.7 + 0.3 * Math.sin(t * 2.6);
        lights.push({ x: c.x, y: c.y, r: 30 * pulse, c0: `rgba(255,170,80,${(0.3 * pulse).toFixed(3)})`, a: 1, c1: 'rgba(255,170,80,0)' });
      } else {
        const blink = hash1(t * 1.1, 41) > 0.9 ? 0.16 : 0.04;
        lights.push({ x: c.x, y: c.y, r: 10, c0: `rgba(255,80,60,${blink.toFixed(3)})`, a: 1, c1: 'rgba(255,80,60,0)' });
      }
    }
    // creature threat lamp
    if (w.creatureActive) {
      const hunting = w.creature.state === 'hunt';
      const base = hunting ? 15 : 9;
      const pulse = 0.75 + 0.25 * Math.sin(t * (hunting ? 7 : 3));
      lights.push({ x: w.creature.x, y: w.creature.y - 2, r: base + w.threat * 6, c0: `rgba(255,60,50,${(0.2 + (hunting ? 0.2 : 0) * pulse).toFixed(3)})`, a: 1, c1: 'rgba(255,60,50,0)' });
    }
    // decoy ping (you can see where the static wants it to look)
    const decoy = w.effects.find((e) => e.kind === 'decoy' && e.until > w.t);
    if (decoy) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 5);
      lights.push({ x: decoy.tx ?? 0, y: decoy.ty ?? 0, r: 20 * pulse, c0: `rgba(140,220,255,${(0.2 * pulse).toFixed(3)})`, a: 1, c1: 'rgba(140,220,255,0)' });
    }

    lctx.save();
    lctx.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      const px = lx(L.x);
      const py = ly(L.y);
      lctx.globalAlpha = 1;
      if (L.wedge) {
        // Nested, wall-clipped lobes give the torch a soft spill and bright core.
        for (const [width, reach, strength] of [
          [1, 1, 0.14], [0.88, 0.98, 0.18], [0.74, 0.94, 0.26],
          [0.58, 0.88, 0.34], [0.38, 0.78, 0.44],
        ] as const) {
          const len = L.wedge.len * reach;
          const points = traceLightCone(w.map, w.gateOpen, L,
            { x: L.wedge.dx, y: L.wedge.dy }, len, L.wedge.half * width);
          const g = lctx.createRadialGradient(px, py, 0, px, py, s * len);
          g.addColorStop(0, `rgba(255,232,195,${(strength * L.a).toFixed(3)})`);
          g.addColorStop(0.45, `rgba(255,219,168,${(strength * L.a * 0.72).toFixed(3)})`);
          g.addColorStop(1, 'rgba(255,210,155,0)');
          lctx.fillStyle = g;
          lctx.beginPath();
          lctx.moveTo(px, py);
          for (const point of points) lctx.lineTo(lx(point.x), ly(point.y));
          lctx.closePath();
          lctx.fill();
        }
        continue;
      }
      const g = lctx.createRadialGradient(px, py, s * L.r * 0.12, px, py, Math.max(1, s * L.r));
      lctx.globalAlpha = L.a;
      g.addColorStop(0, L.c0);
      g.addColorStop(1, L.c1 ?? 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.beginPath();
      lctx.arc(px, py, Math.max(1, s * L.r), 0, Math.PI * 2);
      lctx.fill();
    }
    lctx.restore();
  }

  private drawGlows(w: World, t: number, ready: boolean, wx: (x: number) => number, wy: (y: number) => number): void {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Visible fluorescent tubes anchor the light pools in the room geometry.
    for (const room of w.map.rooms) {
      const powered = room.id === 'arrival' || (room.id === 'exit' ? w.gateOpen
        : w.relays.some((r, i) => r.room === room.id && w.relayDone[i]));
      const rgb = powered ? '176,232,238' : room.id === 'archives' ? '245,183,108' : '114,186,224';
      for (const lamp of room.lamps) {
        const x = wx(lamp.x);
        const y = wy(lamp.y - 6);
        if (x < -50 || x > this.cssW + 50 || y < -50 || y > this.cssH + 50) continue;
        const halo = ctx.createRadialGradient(x, y, 0, x, y, s * 10);
        halo.addColorStop(0, `rgba(${rgb},${powered ? 0.18 : 0.1})`);
        halo.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = halo;
        ctx.fillRect(x - s * 10, y - s * 10, s * 20, s * 20);
        ctx.fillStyle = `rgba(${rgb},${powered ? 0.85 : 0.5})`;
        ctx.fillRect(x - s * 3.2, y - s * 0.22, s * 6.4, Math.max(1, s * 0.45));
      }
    }
    // creature eyes (visible even in full dark — that's how you find it)
    if (w.creatureActive || ready) {
      const cx = wx(w.creature.x);
      const cy = wy(w.creature.y);
      const dirX = Math.sign(w.player.x - w.creature.x) || 1;
      const hunting = w.creature.state === 'hunt';
      const blink = hash1(t * 5.5, 61) > 0.94 ? 0.2 : 1;
      for (const ox of [-0.5, 0.5]) {
        const ex = cx + dirX * s * 0.9 + ox * s * 0.55;
        const ey = cy - s * 9.2;
        const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, s * (hunting ? 2.6 : 1.6));
        g.addColorStop(0, `rgba(255,70,55,${(0.9 * blink).toFixed(3)})`);
        g.addColorStop(0.4, `rgba(255,60,45,${(0.5 * blink).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,60,45,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(ex, ey, s * (hunting ? 2.6 : 1.6), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,120,90,${(0.95 * blink).toFixed(3)})`;
        ctx.fillRect(ex - s * 0.22, ey - s * 0.16, s * 0.44, s * 0.32);
      }
    }
    // relay blips
    for (let i = 0; i < w.relays.length; i++) {
      const r = w.relays[i]!;
      const done = w.relayDone[i]!;
      const bx = wx(r.x);
      const by = wy(r.y) - s * 11;
      if (done) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + i);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, s * 2.4);
        g.addColorStop(0, `rgba(150,255,235,${(0.55 + 0.3 * pulse).toFixed(3)})`);
        g.addColorStop(1, 'rgba(150,255,235,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, s * 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const blink = hash1(t * 1.6, 23 + i) > 0.86 ? 0.7 : 0.15;
        ctx.fillStyle = `rgba(255,90,70,${blink.toFixed(3)})`;
        ctx.fillRect(bx - s * 0.3, by - s * 0.3, s * 0.6, s * 0.6);
      }
    }
    // gate beacon + console bloom
    {
      const c = w.map.consoleSite;
      const bx = wx(c.x);
      const by = wy(c.y) - s * 9;
      const pulse = 0.5 + 0.5 * Math.sin(t * (w.gateOpen ? 3 : 1.2));
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, s * 2.2);
      g.addColorStop(0, w.gateOpen ? `rgba(255,190,90,${(0.35 + 0.35 * pulse).toFixed(3)})` : `rgba(255,70,55,${(0.12 + 0.2 * pulse).toFixed(3)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, s * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawOverlays(w: World, t: number, ready: boolean): void {
    const ctx = this.ctx;
    const hw = this.cssW / 2;
    const hh = this.cssH / 2;
    ctx.save();
    // fog vignette
    const vg = ctx.createRadialGradient(hw, hh, Math.min(hw, hh) * 0.5, hw, hh, Math.max(hw, hh) * 1.12);
    vg.addColorStop(0, 'rgba(4,5,8,0)');
    vg.addColorStop(0.75, 'rgba(4,5,8,0.16)');
    vg.addColorStop(1, 'rgba(3,4,6,0.48)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    // threat edge whisper
    if (w.threat > 0.08 && !ready) {
      const a = Math.min(0.34, (w.threat - 0.08) * 0.42) * (0.75 + 0.25 * Math.sin(t * (w.creature.state === 'hunt' ? 9 : 2.4)));
      const rg = ctx.createRadialGradient(hw, hh, Math.min(hw, hh) * 0.45, hw, hh, Math.max(hw, hh) * 1.05);
      rg.addColorStop(0, 'rgba(120,10,8,0)');
      rg.addColorStop(1, `rgba(150,16,12,${a.toFixed(3)})`);
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    // hurt flash
    if (w.player.hurtFlash > 0.01) {
      const a = Math.min(0.5, w.player.hurtFlash * 0.5);
      const rg = ctx.createRadialGradient(hw, hh, Math.min(hw, hh) * 0.2, hw, hh, Math.max(hw, hh));
      rg.addColorStop(0, 'rgba(120,0,0,0)');
      rg.addColorStop(1, `rgba(160,10,6,${a.toFixed(3)})`);
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    // phase washes
    if (w.phase === 'paused') {
      ctx.fillStyle = 'rgba(4,5,9,0.42)';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    } else if (w.phase === 'choice') {
      ctx.fillStyle = 'rgba(5,8,12,0.3)';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    } else if (w.phase === 'won') {
      const warm = w.choiceMade === 'release' ? 'rgba(90,40,10,0.34)' : 'rgba(8,30,32,0.4)';
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    } else if (w.phase === 'dead') {
      ctx.fillStyle = 'rgba(10,2,2,0.6)';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    if (ready) {
      // ambient sweep line
      const yy = ((t * 0.055) % 1) * this.cssH;
      const g = ctx.createLinearGradient(0, yy - 80, 0, yy + 80);
      g.addColorStop(0, 'rgba(140,180,200,0)');
      g.addColorStop(0.5, 'rgba(140,180,200,0.05)');
      g.addColorStop(1, 'rgba(140,180,200,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, yy - 80, this.cssW, 160);
    }
    // film grain
    if (this.grain) {
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.05;
      const gx = Math.floor(t * 13) % 64;
      const gy = Math.floor(t * 7) % 64;
      for (let ix = -1; ix < Math.ceil(this.cssW / 128) + 1; ix++) {
        for (let iy = -1; iy < Math.ceil(this.cssH / 128) + 1; iy++) {
          ctx.drawImage(this.grain, ix * 128 - gx, iy * 128 - gy);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  private drawReticle(w: World, opts: RenderOpts): void {
    if (!opts.pointerActive || !opts.pointerCss || w.phase === 'ready') return;
    const ctx = this.ctx;
    const { x, y } = opts.pointerCss;
    ctx.save();
    ctx.strokeStyle = 'rgba(230,220,200,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(230,220,200,0.8)';
    ctx.fillRect(x - 1, y - 1, 2, 2);
    ctx.restore();
  }
}
