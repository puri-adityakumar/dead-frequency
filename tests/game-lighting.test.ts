import assert from 'node:assert/strict';
import { test } from 'node:test';
import { traceLightCone } from '../src/game/lighting';
import { createMap, TILE, TILE_FLOOR, TILE_GATE, TILE_WALL } from '../src/game/map';

test('flashlight ray fan has bounded reach and does not mutate the map', () => {
  const map = createMap(42);
  map.tiles.fill(TILE_FLOOR);
  const original = map.tiles.slice();
  const origin = { x: TILE * 10.5, y: TILE * 10.5 };
  const points = traceLightCone(map, false, origin, { x: 1, y: 0 }, 64, 0.5);
  assert.equal(points.length, 41);
  for (const point of points) {
    assert.ok(Math.abs(Math.hypot(point.x - origin.x, point.y - origin.y) - 64) < 0.001);
    assert.ok(point.x > origin.x);
  }
  assert.deepEqual(map.tiles, original);
});

test('flashlight stops at walls and sealed gates, but passes through open gates', () => {
  const map = createMap(42);
  map.tiles.fill(TILE_FLOOR);
  const origin = { x: TILE * 10.5, y: TILE * 10.5 };
  const direction = { x: 1, y: 0 };
  const barrierX = 13;
  const wallFace = barrierX * TILE;
  for (const tile of [TILE_WALL, TILE_GATE]) {
    for (let y = 0; y < map.h; y++) map.tiles[y * map.w + barrierX] = tile;
    const sealed = traceLightCone(map, false, origin, direction, 80, 0.4);
    for (const point of sealed) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x <= wallFace + 3, `${tile} leaked past a sealed barrier at x=${point.x}`);
    }
    const open = traceLightCone(map, true, origin, direction, 80, 0.4);
    if (tile === TILE_WALL) {
      for (const point of open) assert.ok(point.x <= wallFace + 3, `wall leaked when gateOpen=true at x=${point.x}`);
    } else {
      for (const point of open) {
        assert.ok(Math.abs(Math.hypot(point.x - origin.x, point.y - origin.y) - 80) < 0.001);
        assert.ok(point.x > wallFace, `open gate blocked a ray at x=${point.x}`);
      }
    }
  }
});
