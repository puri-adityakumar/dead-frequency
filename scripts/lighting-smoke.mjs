import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';

// Isolated renderer scenes, not gameplay cheats. No app/API requests or paid calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureOnly = process.argv.includes('--capture-only');
const out = path.resolve(root, process.argv.find((arg) => arg.startsWith('--out='))?.slice(6)
  ?? 'test-results/lighting');
await fs.mkdir(out, { recursive: true });
const modules = ['rng', 'map', 'nav', 'sim', 'lighting', 'render'];
const factories = await Promise.all(modules.map(async (name) => {
  const source = await fs.readFile(path.join(root, 'src/game', `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  return `${JSON.stringify(`./${name}`)}: function(require, exports) {\n${outputText}\n}`;
}));
const bundle = `(() => {
  const factories = {${factories.join(',\n')}};
  const cache = {};
  const load = (name) => {
    if (!cache[name]) {
      const exports = cache[name] = {};
      if (!factories[name]) throw new Error('Unexpected renderer import: ' + name);
      factories[name](load, exports);
    }
    return cache[name];
  };
  window.lightingScene = { ...load('./sim'), ...load('./render'), ...load('./map') };
})();`;
const chromePath = process.env.CHROME_PATH
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Prevent all network traffic; these tests use only the local renderer sources.
  await page.route('**/*', (route) => route.abort());
  await page.setContent('<div class="df-shell"><canvas class="df-canvas"></canvas><div class="df-scanlines"></div><div class="df-vignette"></div></div>');
  await page.addStyleTag({ content: await fs.readFile(path.join(root, 'src/app/globals.css'), 'utf8') });
  await page.addScriptTag({ content: bundle });
  for (const room of ['arrival', 'medical', 'archives', 'reactor', 'exit']) {
    const modes = room === 'arrival' ? ['off', 'on']
      : room === 'exit' ? ['off', 'on', 'gate']
        : ['off', 'on', 'restored'];
    for (const mode of modes) {
      const result = await page.evaluate(({ room, mode }) => {
        const { createWorld, Renderer, TILE, TILE_FLOOR } = window.lightingScene;
        const w = createWorld(20261031);
        const site = w.map.rooms.find((site) => site.id === room);
        const relayIndex = w.relays.findIndex((r) => r.room === room);
        w.phase = 'playing';
        w.player.x = site.cx + 20;
        w.player.y = site.cy + 22;
        w.player.aimX = 0.8;
        w.player.aimY = -0.6;
        w.player.flashlight = mode === 'on';
        w.player.room = room;
        if (mode === 'restored') w.relayDone[relayIndex] = true;
        if (mode === 'gate') {
          // The exit is only powered when all three relays hold and the gate opens.
          w.gateOpen = true;
          w.relayDone.fill(true);
        }
        const relay = relayIndex >= 0 ? w.relays[relayIndex] : null;
        const canvas = document.querySelector('canvas');
        const renderer = new Renderer(canvas);
        renderer.setCssSize(1280, 800);
        renderer.render(w, { timeSec: 4, pointerCss: null, pointerActive: false });
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const values = [];
        const relayValues = [];
        for (let y = 80; y < 720; y += 4) {
          for (let x = 80; x < 1200; x += 4) {
            const wp = renderer.worldFromScreen(x, y);
            const tx = Math.floor(wp.x / TILE);
            const ty = Math.floor(wp.y / TILE);
            if (tx < site.x0 || tx > site.x1 || ty < site.y0 || ty > site.y1) continue;
            if (w.map.tiles[ty * w.map.w + tx] !== TILE_FLOOR) continue;
            const i = (Math.floor(y * renderer.dpr) * canvas.width + Math.floor(x * renderer.dpr)) * 4;
            const lum = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
            values.push(lum);
            const relayDistance = relay ? Math.hypot(wp.x - relay.x, wp.y - relay.y) : Infinity;
            // Annulus avoids the dark relay pedestal itself and samples its halo.
            if (relayDistance >= 10 && relayDistance <= 20) relayValues.push(lum);
          }
        }
        values.sort((a, b) => a - b);
        return { room, mode, samples: values.length,
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          p10: values[Math.floor(values.length * 0.1)], p90: values[Math.floor(values.length * 0.9)],
          relaySamples: relayValues.length,
          relayMean: relayValues.length ? relayValues.reduce((a, b) => a + b, 0) / relayValues.length : null };
      }, { room, mode });
      results.push(result);
      await page.screenshot({ path: path.join(out, `${room}-${mode}.png`) });
      console.log(`${captureOnly ? 'CAPTURE' : 'CHECK'} ${room}/${mode}: mean ${result.mean.toFixed(1)}, p10 ${result.p10.toFixed(1)}, p90 ${result.p90.toFixed(1)}${result.relayMean === null ? '' : `, relay ${result.relayMean.toFixed(1)}`}`);
    }
  }

  // Directional probe: compare the same frame pixels with the beam off and on.
  // A radial glow would brighten evenly; only a cone should favour the aim side.
  const beamProbe = await page.evaluate(() => {
    const { createWorld, Renderer } = window.lightingScene;
    const w = createWorld(20261031);
    const site = w.map.rooms.find((room) => room.id === 'arrival');
    w.phase = 'playing';
    w.player.x = site.cx + 20;
    w.player.y = site.cy + 22;
    w.player.aimX = 0.8;
    w.player.aimY = -0.6;
    w.player.room = 'arrival';
    w.player.flashlight = false;
    const canvas = document.querySelector('canvas');
    const renderer = new Renderer(canvas);
    renderer.setCssSize(1280, 800);
    const sample = () => {
      renderer.render(w, { timeSec: 4, pointerCss: null, pointerActive: false });
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const values = [];
      for (let y = 80; y < 720; y += 4) {
        for (let x = 80; x < 1200; x += 4) {
          const wp = renderer.worldFromScreen(x, y);
          const dx = wp.x - w.player.x;
          const dy = wp.y - w.player.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 4 || distance > 60) continue;
          const i = (Math.floor(y * renderer.dpr) * canvas.width + Math.floor(x * renderer.dpr)) * 4;
          values.push({
            lum: pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722,
            forward: (dx * w.player.aimX + dy * w.player.aimY) / distance,
          });
        }
      }
      return values;
    };
    const off = sample();
    w.player.flashlight = true;
    const on = sample();
    let front = 0;
    let frontN = 0;
    let back = 0;
    let backN = 0;
    for (let i = 0; i < off.length; i++) {
      const delta = on[i].lum - off[i].lum;
      if (off[i].forward >= 0.82) { front += delta; frontN += 1; }
      else if (off[i].forward <= -0.5) { back += delta; backN += 1; }
    }
    return { frontN, backN, frontMean: front / frontN, backMean: back / backN };
  });
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ captureOnly, results, beamProbe, errors }, null, 2));
  assert.deepEqual(errors, []);
  if (!captureOnly) {
    for (const result of results) {
      assert.ok(result.samples > 1000, `${result.room}/${result.mode}: insufficient floor samples`);
      assert.ok(result.mean >= 40, `${result.room}/${result.mode}: room is too dark`);
      assert.ok(result.p10 >= 22, `${result.room}/${result.mode}: shadows hide too much detail`);
      assert.ok(result.p90 >= 40, `${result.room}/${result.mode}: insufficient lit detail`);
      assert.ok(result.p90 - result.p10 >= 12, `${result.room}/${result.mode}: lighting is too flat`);
    }
    for (const room of ['arrival', 'medical', 'archives', 'reactor', 'exit']) {
      const off = results.find((r) => r.room === room && r.mode === 'off');
      const on = results.find((r) => r.room === room && r.mode === 'on');
      assert.ok(on.mean >= off.mean + 0.5, `${room}: flashlight must visibly brighten the room`);
      const restored = results.find((r) => r.room === room && r.mode === 'restored');
      if (restored) {
        assert.ok(restored.mean >= off.mean + 4, `${room}: restored relay must brighten its room`);
        assert.ok(restored.relaySamples > 100, `${room}: insufficient local relay samples`);
        assert.ok(restored.relayMean >= off.relayMean + 4, `${room}: restored relay must light its own pedestal halo`);
      }
      const gate = results.find((r) => r.room === room && r.mode === 'gate');
      if (gate) assert.ok(gate.mean >= off.mean + 4, `${room}: opening the gate must power the exit room`);
    }
    console.log(`CHECK beam-direction: front +${beamProbe.frontMean.toFixed(1)} (${beamProbe.frontN}), back +${beamProbe.backMean.toFixed(1)} (${beamProbe.backN})`);
    assert.ok(beamProbe.frontN > 100 && beamProbe.backN > 100, 'beam probe: insufficient frame samples');
    assert.ok(beamProbe.frontMean >= 4, 'beam probe: flashlight does not brighten the aim side');
    assert.ok(beamProbe.frontMean - beamProbe.backMean >= 4, 'beam probe: flashlight is not directional');
    console.log(`PASS: ${results.length} deterministic lighting scenes. No network requests.`);
  }
  console.log(`Lighting captures: ${out}`);
} finally {
  await browser.close();
}
