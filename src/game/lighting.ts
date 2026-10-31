import type { GameMap } from './map';
import { TILE } from './map';
import { tileSolid } from './nav';

export interface LightPoint { x: number; y: number }

/** Visual-only ray fan. Walls and sealed gates stop the beam, not game state. */
export function traceLightCone(
  map: GameMap,
  gateOpen: boolean,
  origin: LightPoint,
  direction: LightPoint,
  length: number,
  halfAngle: number,
  rays = 40,
): LightPoint[] {
  const angle = Math.atan2(direction.y, direction.x);
  const points: LightPoint[] = [];
  const step = TILE / 4;
  for (let i = 0; i <= rays; i++) {
    const a = angle - halfAngle + (i / rays) * halfAngle * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let distance = length;
    for (let d = step; d <= length; d += step) {
      const tx = Math.floor((origin.x + dx * d) / TILE);
      const ty = Math.floor((origin.y + dy * d) / TILE);
      if (tileSolid(map, gateOpen, tx, ty)) {
        // A small overlap illuminates the wall face without leaking through it.
        distance = Math.min(length, d + 1);
        break;
      }
    }
    points.push({ x: origin.x + dx * distance, y: origin.y + dy * distance });
  }
  return points;
}
