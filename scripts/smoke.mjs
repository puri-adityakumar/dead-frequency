#!/usr/bin/env node
/**
 * Dead Frequency end-to-end smoke harness.
 *
 * Run against an already-running app:
 *
 *   node scripts/smoke.mjs http://localhost:3000
 *
 * This file intentionally owns no application code. It drives the real UI in a
 * locally installed Chrome through playwright-core, intercepts every
 * POST /api/director in every browser context, and fulfils an explicitly
 * scripted DirectorResponse. No request from this harness can reach Tinker or
 * spend inference credits.
 *
 * Exit codes: 0 = no FAIL/BLOCKED, 1 = failed or blocked, 2 = setup/config failure.
 * Screenshots and report.json go under the git-ignored test-results/ directory.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const ROOM_IDS = ['arrival', 'medical', 'archives', 'reactor', 'exit'];
const MILESTONES = ['start', 'room_enter', 'relay_restored', 'near_death', 'exit_ready'];
const DIRECTIVE_TIMEOUT_MS = 9000; // matches the UI client's hard timeout

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Setup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const results = [];
const diagnostics = { baseUrl: args.baseUrl, chromePath: null, suites: [], startedAt: new Date().toISOString() };

/* ------------------------------------------------------------------ setup */

class SetupError extends Error {}

function parseArgs(argv) {
  const opts = {
    baseUrl: null,
    headed: false,
    timeoutMs: 25_000,
    engineTimeoutMs: 20_000,
    actionTimeoutMs: 8_000,
    outDir: null,
    skipSlow: false,
    skipTouch: false,
    totalTimeoutMs: 180_000,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      opts.help = true;
      continue;
    }
    if (raw === '--headed') {
      opts.headed = true;
      continue;
    }
    if (raw === '--skip-slow') {
      opts.skipSlow = true;
      continue;
    }
    if (raw === '--skip-touch') {
      opts.skipTouch = true;
      continue;
    }
    if (raw.startsWith('--')) {
      const [flag, value] = raw.slice(2).split('=');
      if (!value) throw new SetupError(`flag --${flag} needs a value, e.g. --${flag}=...`);
      if (flag === 'timeout-ms') opts.timeoutMs = positiveInt(value, flag);
      else if (flag === 'engine-timeout-ms') opts.engineTimeoutMs = positiveInt(value, flag);
      else if (flag === 'action-timeout-ms') opts.actionTimeoutMs = positiveInt(value, flag);
      else if (flag === 'total-timeout-ms') opts.totalTimeoutMs = positiveInt(value, flag);
      else if (flag === 'out') opts.outDir = path.resolve(process.cwd(), value);
      else throw new SetupError(`unknown flag --${flag}`);
      continue;
    }
    if (opts.baseUrl) throw new SetupError(`unexpected argument: ${raw}`);
    opts.baseUrl = raw;
  }
  return opts;
}

function positiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SetupError(`--${flag} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Dead Frequency smoke harness

Usage:
  node scripts/smoke.mjs <base-url> [options]

Options:
  --headed                 show the browser window
  --timeout-ms=25000       navigation timeout
  --engine-timeout-ms=20000  how long to wait for the engine/HUD to appear
  --action-timeout-ms=8000   per-interaction wait budget
  --total-timeout-ms=180000  watchdog for the whole run
  --skip-slow              skip the 9s director-timeout scenario
  --skip-touch             skip the narrow-screen touch scenario
  --out=DIR                diagnostics directory (default test-results/smoke/<stamp>)

Environment:
  CHROME_PATH              optional explicit Chrome/Chromium executable

The app must already be running. This harness never starts a server and never
lets a director request escape to the network.`);
}

function executable(pathname) {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!executable(process.env.CHROME_PATH)) {
      throw new SetupError(`CHROME_PATH is set but not executable: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
  for (const candidate of candidates) {
    if (executable(candidate)) return candidate;
  }

  // playwright-core never downloads a browser, but a browser installed through
  // Playwright may still exist on developer machines.
  try {
    const bundled = chromium.executablePath();
    if (bundled && executable(bundled)) return bundled;
  } catch {
    // no bundled browser
  }

  throw new SetupError(
    'No Chrome/Chromium found. Set CHROME_PATH to a Chrome executable, e.g. ' +
      'CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".',
  );
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureOutDir() {
  const dir = args.outDir || path.join(REPO_ROOT, 'test-results', 'smoke', stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------------------------------------------------------- reporting */

const STATUS_ORDER = ['FAIL', 'BLOCKED', 'WARN', 'SKIP', 'PASS'];

function record(status, id, detail, extra) {
  const entry = { status, id, detail: detail || '', extra: extra ?? null, at: new Date().toISOString() };
  results.push(entry);
  const label = `[${status}]`.padEnd(10);
  console.log(`${label} ${id}${detail ? ` — ${detail}` : ''}`);
}

function fail(id, error) {
  record('FAIL', id, shortError(error));
}

function shortError(error) {
  if (!error) return 'unknown error';
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 400);
}

function counts() {
  const tally = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, BLOCKED: 0 };
  for (const result of results) tally[result.status] += 1;
  return tally;
}

function browserErrorNoise(entry, { allowDirectorNoise = false, engineMissing = false } = {}) {
  const text = `${entry.text || ''} ${entry.url || ''}`;
  if (/favicon|react devtools|download the react devtools/i.test(text)) return true;
  if (allowDirectorNoise && /api\/director/i.test(text)) return true;
  if (allowDirectorNoise && /net::ERR_(FAILED|ABORTED)|Failed to load resource/i.test(text)) return true;
  if (
    engineMissing &&
    /cannot find module|Failed to fetch dynamically imported module|_next\/static\/chunks|@\/game|engine/i.test(text)
  ) {
    return true;
  }
  return false;
}

function trackPage(page, label) {
  const state = { label, consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on('pageerror', (error) => {
    state.pageErrors.push({ text: String(error?.stack || error) });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location() || {};
    state.consoleErrors.push({ text: message.text(), url: location.url || '' });
  });
  page.on('requestfailed', (request) => {
    state.failedRequests.push({
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText || '',
    });
  });
  return state;
}

function recordBrowserErrors(id, state, options = {}) {
  if (state.pageErrors.length) {
    record('FAIL', id, `${state.pageErrors.length} uncaught page error(s): ${shortError(state.pageErrors[0].text)}`, state.pageErrors);
    return false;
  }
  const real = state.consoleErrors.filter((entry) => !browserErrorNoise(entry, options));
  if (real.length) {
    record('FAIL', id, `${real.length} console error(s): ${shortError(real[0].text)}`, real);
    return false;
  }
  record('PASS', id, 'no uncaught page errors or unexpected console errors');
  return true;
}

/* ------------------------------------------------------------- director mock */

function validFallback(room, marker) {
  return {
    source: 'fallback',
    event: {
      action: 'whisper',
      room,
      message: `${marker} · carrier checked, no station answers`,
      intensity: 0.05,
    },
    reason: 'mock_scripted',
  };
}

function roomFromBody(body) {
  return body && ROOM_IDS.includes(body.room) ? body.room : 'arrival';
}

function jsonFulfil(status, payload) {
  return {
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

/**
 * Intercepts POST /api/director for one context. Modes:
 * fallback (default) | error | abort | slow | timeout
 * Every path is explicitly scripted; nothing is proxied.
 */
function installDirectorMock(context, mode, label = mode) {
  const state = { mode, label, requests: [], closed: false, pending: 0 };
  context.route('**/api/director', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      try {
        await route.continue();
      } catch {
        // context closed
      }
      return;
    }
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    state.requests.push({ at: Date.now(), body, url: request.url() });
    state.pending += 1;
    try {
      const room = roomFromBody(body);
      if (mode === 'error') {
        await route.fulfill(jsonFulfil(500, { error: 'mock director failure' }));
      } else if (mode === 'abort') {
        await route.abort('failed');
      } else if (mode === 'slow') {
        await delay(1_500);
        if (!state.closed) await route.fulfill(jsonFulfil(200, validFallback(room, 'mock fallback slow')));
      } else if (mode === 'timeout') {
        await delay(DIRECTIVE_TIMEOUT_MS + 700);
        if (!state.closed) await route.fulfill(jsonFulfil(200, validFallback(room, 'mock fallback late')));
      } else {
        await route.fulfill(jsonFulfil(200, validFallback(room, 'mock fallback')));
      }
    } catch {
      // The page/context closed mid-request; nothing to assert here.
    } finally {
      state.pending -= 1;
    }
  });
  return state;
}

function closeMock(state) {
  state.closed = true;
}

function validateDirectorState(body) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body is not a JSON object'];
  const numbers = ['seed', 'elapsed', 'health', 'threat'];
  for (const key of numbers) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) problems.push(`${key} is not a finite number`);
  }
  if (!ROOM_IDS.includes(body.room)) problems.push(`room is not one of ${ROOM_IDS.join(', ')}`);
  if (!MILESTONES.includes(body.milestone)) problems.push('milestone is not a contract value');
  if (!Array.isArray(body.visitedRooms) || body.visitedRooms.some((room) => !ROOM_IDS.includes(room))) {
    problems.push('visitedRooms is not a room list');
  } else if (new Set(body.visitedRooms).size !== body.visitedRooms.length) {
    problems.push('visitedRooms contains duplicates');
  }
  if (!Number.isInteger(body.relays) || body.relays < 0 || body.relays > 3) problems.push('relays out of range');
  if (typeof body.health !== 'number' || body.health < 0 || body.health > 100) problems.push('health out of range');
  if (typeof body.threat !== 'number' || body.threat < 0 || body.threat > 1) problems.push('threat out of range');
  if (typeof body.flashlight !== 'boolean') problems.push('flashlight is not boolean');
  if (!Array.isArray(body.recentMessages) || body.recentMessages.length > 8) problems.push('recentMessages is not a bounded list');
  if (Array.isArray(body.recentMessages) && body.recentMessages.some((item) =>
    typeof item !== 'string' || item.length > 160 || /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/.test(item))) {
    problems.push('recentMessages contains invalid text');
  }
  return problems;
}

/* -------------------------------------------------------------- page helpers */

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gotoApp(page) {
  await page.goto(args.baseUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
}

function startButton(page) {
  return page.getByRole('button', { name: /begin transmission/i }).first();
}

function pauseButton(page) {
  return page.getByRole('button', { name: /pause the run/i }).first();
}

function anyDialog(page) {
  return page.getByRole('dialog').first();
}

function pauseDialog(page) {
  return page.getByRole('dialog').filter({ hasText: /feed paused/i }).first();
}

function radioFeed(page) {
  return page.getByRole('complementary', { name: /radio transcript/i }).first();
}

function directorBadge(page) {
  return page.getByRole('status', { name: /director link/i }).first();
}

async function waitForEngine(page) {
  const deadline = Date.now() + args.engineTimeoutMs;
  let bootText = '';
  while (Date.now() < deadline) {
    if (await startButton(page).isVisible().catch(() => false)) return { ready: true, fault: false, bootText };
    const dialog = anyDialog(page);
    if (await dialog.count().catch(() => 0)) {
      bootText = (await dialog.textContent().catch(() => '')) || bootText;
      if (/engine fault|simulation could not start/i.test(bootText)) return { ready: false, fault: true, bootText };
    }
    await page.waitForTimeout(250);
  }
  return { ready: false, fault: false, bootText };
}

async function beginRun(page) {
  const button = startButton(page);
  await button.waitFor({ state: 'visible', timeout: args.engineTimeoutMs });
  await button.click();
  await pauseButton(page).waitFor({ state: 'visible', timeout: args.actionTimeoutMs });
}

async function readScene(page) {
  const text = (await page.locator('body').textContent().catch(() => '')) || '';
  const clocks = [...text.matchAll(/elapsed\s+(\d{2}):(\d{2})/g)];
  const lastClock = clocks.at(-1);
  const rooms = [...text.matchAll(/([A-Z][A-Za-z]+(?:\s+[a-z]+)?),\s*elapsed\s+\d{2}:\d{2}/g)];
  const seed = text.match(/SEED\s+(\d+)/);
  return {
    clockSeconds: lastClock ? Number(lastClock[1]) * 60 + Number(lastClock[2]) : null,
    room: rooms.at(-1) ? rooms.at(-1)[1] : null,
    seed: seed ? Number(seed[1]) : null,
  };
}

async function meterValue(page, name) {
  const meter = page.getByRole('meter', { name }).first();
  if (!(await meter.count().catch(() => 0))) return null;
  const raw = await meter.getAttribute('aria-valuenow').catch(() => null);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function radioText(page) {
  const feed = radioFeed(page);
  if (!(await feed.count().catch(() => 0))) return '';
  return (await feed.textContent().catch(() => '')) || '';
}

async function badgeLabel(page) {
  const badge = directorBadge(page);
  if (!(await badge.count().catch(() => 0))) return '';
  return (await badge.getAttribute('aria-label').catch(() => '')) || '';
}

async function canvasStats(page) {
  const canvas = page.locator('canvas').first();
  if (!(await canvas.count().catch(() => 0))) return null;
  return canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const result = {
      width: element.width || 0,
      height: element.height || 0,
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      pixels: null,
      reason: null,
    };
    let context = null;
    try {
      context = element.getContext('2d');
    } catch (error) {
      result.reason = String(error);
      return result;
    }
    if (!context) {
      result.reason = 'canvas is not a readable 2D context';
      return result;
    }
    try {
      const width = element.width;
      const height = element.height;
      if (!width || !height) {
        result.reason = 'canvas backing store is empty';
        return result;
      }
      const data = context.getImageData(0, 0, width, height).data;
      const cols = 24;
      const rows = 14;
      const grid = [];
      let min = 255;
      let max = 0;
      let sum = 0;
      let sampled = 0;
      let nonBlack = 0;
      for (let gy = 0; gy < rows; gy += 1) {
        for (let gx = 0; gx < cols; gx += 1) {
          const x0 = Math.floor((gx * width) / cols);
          const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cols));
          const y0 = Math.floor((gy * height) / rows);
          const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / rows));
          const stepX = Math.max(1, Math.floor((x1 - x0) / 10));
          const stepY = Math.max(1, Math.floor((y1 - y0) / 10));
          let cellSum = 0;
          let cellCount = 0;
          for (let y = y0; y < y1; y += stepY) {
            for (let x = x0; x < x1; x += stepX) {
              const index = (y * width + x) * 4;
              const lum = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
              cellSum += lum;
              cellCount += 1;
              sum += lum;
              sampled += 1;
              if (lum > 8) nonBlack += 1;
              if (lum < min) min = lum;
              if (lum > max) max = lum;
            }
          }
          grid.push(Math.round(cellSum / Math.max(1, cellCount)));
        }
      }
      result.pixels = {
        min: Math.round(min),
        max: Math.round(max),
        mean: Math.round(sum / Math.max(1, sampled)),
        nonBlack: nonBlack / Math.max(1, sampled),
        grid,
      };
    } catch (error) {
      result.reason = String(error);
    }
    return result;
  });
}

function gridDrift(before, after) {
  if (!before?.pixels?.grid || !after?.pixels?.grid) return null;
  if (before.pixels.grid.length !== after.pixels.grid.length) return null;
  let changed = 0;
  for (let index = 0; index < before.pixels.grid.length; index += 1) {
    if (Math.abs(before.pixels.grid[index] - after.pixels.grid[index]) >= 6) changed += 1;
  }
  return (changed / before.pixels.grid.length) * 100;
}

async function screenshot(page, outDir, name) {
  try {
    const target = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: target, timeout: 5_000 });
    return target;
  } catch {
    return null;
  }
}

async function waitForBadge(page, pattern, timeoutMs) {
  await page.getByRole('status', { name: pattern }).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

async function waitForRequest(mock, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mock.requests.length > 0) return mock.requests[0];
    await delay(150);
  }
  return null;
}

async function countWindowKeydown(page) {
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    const response = await client.send('Runtime.evaluate', {
      expression:
        '(()=>{try{return typeof getEventListeners==="function" ? (getEventListeners(window).keydown||[]).length : -1}catch(e){return -1}})()',
      includeCommandLineAPI: true,
      returnByValue: true,
    });
    const value = response?.result?.value;
    return typeof value === 'number' && value >= 0 ? value : null;
  } catch {
    return null;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

/* ---------------------------------------------------------------- suites */

async function runDesktopSuite(browser, outDir) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const mock = installDirectorMock(context, 'fallback');
  const page = await context.newPage();
  const errors = trackPage(page, 'desktop');
  const suite = { label: 'desktop', requests: mock.requests, errors, scenes: {} };
  diagnostics.suites.push(suite);
  let engineReady = false;

  try {
    try {
      await gotoApp(page);
      record('PASS', 'page.load', args.baseUrl);
    } catch (error) {
      fail('page.load', `${shortError(error)} (is the app running at ${args.baseUrl}?)`);
      return { engineReady: false, requestSeen: false };
    }

    const title = await page.title().catch(() => '');
    if (/dead frequency/i.test(title)) record('PASS', 'shell.title', title);
    else record('FAIL', 'shell.title', `unexpected title: "${title}"`);

    const root = page.getByRole('main', { name: /dead frequency/i }).first();
    if (await root.isVisible().catch(() => false)) record('PASS', 'shell.root', 'main[aria-label] visible');
    else record('FAIL', 'shell.root', 'main landmark is missing or hidden');

    const canvas = await canvasStats(page);
    suite.scenes.bootCanvas = canvas;
    if (canvas && canvas.cssWidth > 0 && canvas.cssHeight > 0) {
      record('PASS', 'shell.canvas', `canvas box ${canvas.cssWidth}x${canvas.cssHeight}, backing ${canvas.width}x${canvas.height}`);
    } else {
      record('FAIL', 'shell.canvas', 'canvas is missing or has a zero-sized box');
    }

    const engine = await waitForEngine(page);
    engineReady = engine.ready;
    if (!engineReady) {
      if (engine.fault) {
        record('FAIL', 'game.engine', `engine reported a lifecycle fault: ${shortError(engine.bootText)}`);
      } else {
        record(
          'BLOCKED',
          'game.engine',
          `engine/HUD did not mount within ${args.engineTimeoutMs}ms: ${shortError(engine.bootText || 'no boot panel text')}`,
        );
      }
      await browserErrorCheck('browser.errors.shell', errors, { engineMissing: true });
      return { engineReady: false, requestSeen: false };
    }
    record('PASS', 'game.engine', 'HUD and ready overlay mounted');

    try {
      await beginRun(page);
      record('PASS', 'game.begin', 'Begin transmission moved the run to playing');
    } catch (error) {
      fail('game.begin', error);
    }

    // Rendered canvas: nonzero backing store plus sampled visible pixels.
    try {
      const stats = await canvasStats(page);
      suite.scenes.playingCanvas = stats;
      if (!stats) throw new Error('canvas element not found');
      if (stats.width < 2 || stats.height < 2) throw new Error(`canvas backing store ${stats.width}x${stats.height}`);
      if (!stats.pixels) throw new Error(stats.reason || 'pixels unreadable');
      const { min, max, mean, nonBlack } = stats.pixels;
      if (max - min < 12 || nonBlack < 0.01) {
        throw new Error(`canvas looks blank (range ${min}-${max}, nonBlack ${(nonBlack * 100).toFixed(1)}%)`);
      }
      record(
        'PASS',
        'canvas.render',
        `visible pixels in ${stats.width}x${stats.height}: range ${min}-${max}, mean ${mean}, nonBlack ${(nonBlack * 100).toFixed(1)}%`,
      );
      suite.scenes.playingScreenshot = await screenshot(page, outDir, 'desktop-playing');
    } catch (error) {
      fail('canvas.render', error);
    }

    // Director request + scripted fallback honesty.
    const request = await waitForRequest(mock, args.actionTimeoutMs);
    let requestSeen = Boolean(request);
    if (!request) {
      record('FAIL', 'director.request', `no POST /api/director within ${args.actionTimeoutMs}ms of starting`);
    } else {
      const problems = validateDirectorState(request.body);
      if (problems.length) record('FAIL', 'director.contract', problems.join('; '), request.body);
      else record('PASS', 'director.contract', `milestone=${request.body.milestone}, room=${request.body.room}, relays=${request.body.relays}`);
    }

    if (requestSeen) {
      try {
        await waitForBadge(page, /director link: running local fallback content/i, args.actionTimeoutMs);
        const label = await badgeLabel(page);
        const radio = await radioText(page);
        if (/live operator connected/i.test(label)) {
          record('FAIL', 'director.fallbackBadge', `fallback response was shown as live: "${label}"`);
        } else if (!radio.includes('FALLBACK')) {
          record('FAIL', 'director.fallbackLabel', 'scripted fallback event is missing the FALLBACK radio tag');
        } else if (!radio.includes('mock fallback')) {
          record('FAIL', 'director.fallbackLabel', 'scripted fallback message was not applied to the radio feed');
        } else {
          record('PASS', 'director.fallbackBadge', 'HUD badge reports fallback, not live');
          record('PASS', 'director.fallbackLabel', 'radio feed tags the event FALLBACK with the scripted message');
        }
        suite.scenes.fallbackRadio = radio.slice(-500);
      } catch (error) {
        fail('director.fallbackBadge', `fallback badge never appeared: ${shortError(error)}`);
      }
    } else {
      record('SKIP', 'director.fallbackBadge', 'no director request was made, so there is no response to label');
      record('SKIP', 'director.fallbackLabel', 'no director request was made, so there is no response to label');
    }

    // Keyboard movement: room change, sprint stamina drain, or frame delta
    // clearly above the idle animation drift.
    try {
      const before = await canvasStats(page);
      const idleStart = Date.now();
      await page.waitForTimeout(450);
      const idleAfter = await canvasStats(page);
      const idleDrift = gridDrift(before, idleAfter);
      const idleMs = Math.max(1, Date.now() - idleStart);
      const roomBefore = (await readScene(page)).room;
      const staminaBefore = await meterValue(page, 'Stamina');

      // Press movement first so Shift cannot turn the key into "W" before the
      // engine has latched it; sprint is a separate modifier.
      await page.keyboard.down('w');
      await page.waitForTimeout(80);
      await page.keyboard.down('Shift');
      const moveStart = Date.now();
      await page.waitForTimeout(800);
      await page.keyboard.up('w');
      await page.keyboard.up('Shift');
      const moveMs = Math.max(1, Date.now() - moveStart);
      await page.waitForTimeout(120);

      const moveAfter = await canvasStats(page);
      const moveDrift = gridDrift(idleAfter, moveAfter);
      const sceneAfter = await readScene(page);
      const staminaAfter = await meterValue(page, 'Stamina');

      const roomChanged = Boolean(roomBefore && sceneAfter.room && roomBefore !== sceneAfter.room);
      const staminaDropped = staminaBefore !== null && staminaAfter !== null && staminaAfter <= staminaBefore - 2;
      const idleRate = idleDrift === null ? null : idleDrift / idleMs;
      const moveRate = moveDrift === null ? null : moveDrift / moveMs;
      const frameMoved = idleRate !== null && moveRate !== null && moveRate > Math.max(idleRate * 1.35, idleRate + 0.02);

      const evidence = `room ${roomBefore ?? '?'}→${sceneAfter.room ?? '?'}, stamina ${staminaBefore ?? '?'}→${staminaAfter ?? '?'}, idle drift ${idleDrift?.toFixed(1) ?? '?'}%/${idleMs}ms, move drift ${moveDrift?.toFixed(1) ?? '?'}%/${moveMs}ms`;
      suite.scenes.movement = { roomBefore, roomAfter: sceneAfter.room, staminaBefore, staminaAfter, idleDrift, moveDrift, idleMs, moveMs };

      if (roomChanged || staminaDropped || frameMoved) {
        record('PASS', 'input.movement', evidence);
      } else {
        record('FAIL', 'input.movement', `no movement evidence (${evidence})`);
      }
    } catch (error) {
      fail('input.movement', error);
    }

    // Aim back into the room rather than off-map after the movement check.
    // Verify real lamp state as well as the lightmap, not animation alone.
    try {
      const canvasBox = await page.locator('canvas').first().boundingBox();
      if (canvasBox) await page.mouse.move(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + canvasBox.height * 0.82);
      await page.waitForTimeout(200);
      const before = await canvasStats(page);
      await page.getByRole('status', { name: /^flashlight: off$/i }).waitFor({ state: 'visible' });
      await page.keyboard.press('f');
      await page.getByRole('status', { name: /^flashlight: on$/i }).waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      const after = await canvasStats(page);
      const meanDelta =
        before?.pixels && after?.pixels ? Math.abs(after.pixels.mean - before.pixels.mean) : null;
      const drift = gridDrift(before, after);
      // A cone is deliberately local; a whole-screen mean can hide its effect.
      const gains = before?.pixels?.grid && after?.pixels?.grid
        ? after.pixels.grid.map((value, i) => value - before.pixels.grid[i]) : [];
      const peakGain = gains.length ? Math.max(...gains) : 0;
      const litCells = gains.filter((gain) => gain >= 6).length;
      suite.scenes.flashlight = { meanBefore: before?.pixels?.mean ?? null, meanAfter: after?.pixels?.mean ?? null, drift, peakGain, litCells };
      if ((peakGain >= 8 && litCells >= 3) || (meanDelta !== null && meanDelta >= 1.5) || (drift !== null && drift >= 25)) {
        record('PASS', 'input.flashlight', `lamp state toggled and frame changed after F (mean Δ ${meanDelta?.toFixed(1)}, peak +${peakGain}, ${litCells} lit cells, drift ${drift?.toFixed(1)}%)`);
      } else {
        record(
          'WARN',
          'input.flashlight',
          `lamp state toggled but beam evidence is inconclusive (mean Δ ${meanDelta?.toFixed(1) ?? '?'}, peak +${peakGain}, ${litCells} lit cells, drift ${drift?.toFixed(1) ?? '?'}%); check the lightmap manually`,
        );
      }
    } catch (error) {
      fail('input.flashlight', error);
    }

    // Pause: overlay appears and the clock holds. Then resume.
    try {
      const keysBefore = await countWindowKeydown(page);
      await page.keyboard.press('Escape');
      await pauseDialog(page).waitFor({ state: 'visible', timeout: args.actionTimeoutMs });
      const pausedA = await readScene(page);
      await page.waitForTimeout(1_300);
      const pausedB = await readScene(page);
      const frozen = pausedA.clockSeconds !== null && pausedB.clockSeconds !== null && Math.abs(pausedB.clockSeconds - pausedA.clockSeconds) <= 1;
      if (!frozen) throw new Error(`clock kept moving while paused (${pausedA.clockSeconds}s → ${pausedB.clockSeconds}s)`);
      record('PASS', 'lifecycle.pause', `pause overlay visible; clock held at ${pausedB.clockSeconds}s`);

      await pauseDialog(page).getByRole('button', { name: /^resume$/i }).click();
      await pauseDialog(page).waitFor({ state: 'hidden', timeout: args.actionTimeoutMs });
      const resumeA = await readScene(page);
      await page.waitForTimeout(1_300);
      const resumeB = await readScene(page);
      if (!(resumeA.clockSeconds !== null && resumeB.clockSeconds !== null && resumeB.clockSeconds > resumeA.clockSeconds)) {
        throw new Error(`clock did not advance after resume (${resumeA.clockSeconds}s → ${resumeB.clockSeconds}s)`);
      }
      record('PASS', 'lifecycle.resume', `clock advanced ${resumeA.clockSeconds}s → ${resumeB.clockSeconds}s`);

      // Toggle twice more via single Escape presses: duplicated listeners would
      // skip a state or require two presses.
      await page.keyboard.press('Escape');
      await pauseDialog(page).waitFor({ state: 'visible', timeout: args.actionTimeoutMs });
      await page.keyboard.press('Escape');
      await pauseDialog(page).waitFor({ state: 'hidden', timeout: args.actionTimeoutMs });
      const keysAfter = await countWindowKeydown(page);
      if (keysBefore === null || keysAfter === null) {
        record('WARN', 'cleanup.listeners', 'CDP getEventListeners unavailable; single-press toggles still passed');
      } else if (keysAfter <= keysBefore) {
        record('PASS', 'cleanup.listeners', `window keydown listeners stable at ${keysBefore}→${keysAfter} across pause/resume`);
      } else {
        record('FAIL', 'cleanup.listeners', `window keydown listeners grew ${keysBefore}→${keysAfter} across pause/resume`);
      }
    } catch (error) {
      fail('lifecycle.pause', error);
    }

    // Restart run: pause → Restart run, overlay clears and the clock resets.
    try {
      if (await pauseButton(page).isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await pauseDialog(page).waitFor({ state: 'visible', timeout: args.actionTimeoutMs });
      }
      await pauseDialog(page).getByRole('button', { name: /restart run/i }).click();
      await anyDialog(page).waitFor({ state: 'hidden', timeout: args.actionTimeoutMs });
      await page.waitForTimeout(1_200);
      const scene = await readScene(page);
      if (scene.clockSeconds === null || scene.clockSeconds > 5) {
        throw new Error(`clock did not reset after restart (${scene.clockSeconds}s)`);
      }
      if (scene.seed === null) throw new Error('seed chip missing after restart');
      record('PASS', 'lifecycle.restart', `clock reset to ${scene.clockSeconds}s, seed ${scene.seed} still shown`);
    } catch (error) {
      fail('lifecycle.restart', error);
    }

    // Navigation: reload remounts the shell/engine without uncaught errors.
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
      const remount = await waitForEngine(page);
      if (!remount.ready) throw new Error(`engine did not remount: ${shortError(remount.bootText)}`);
      await beginRun(page);
      record('PASS', 'navigation.reload', 'reload remounted the engine and a new run started');
    } catch (error) {
      fail('navigation.reload', error);
    }

    await browserErrorCheck('browser.errors', errors, {});
    return { engineReady: true, requestSeen };
  } finally {
    await screenshot(page, outDir, 'desktop-final');
    closeMock(mock);
    await context.close().catch(() => {});
  }
}

async function browserErrorCheck(id, errors, options) {
  // Let in-flight console events flush before judging.
  await delay(250);
  return recordBrowserErrors(id, errors, options);
}

async function runDirectorScenario(browser, outDir, spec) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const mock = installDirectorMock(context, spec.mode, spec.id);
  const page = await context.newPage();
  const errors = trackPage(page, spec.id);
  diagnostics.suites.push({ label: spec.id, requests: mock.requests, errors });
  try {
    await gotoApp(page);
    await beginRun(page);
    await spec.run({ page, mock, errors });
    if (errors.pageErrors.length) {
      record('FAIL', spec.id, `uncaught page error: ${shortError(errors.pageErrors[0].text)}`);
    }
    await screenshot(page, outDir, spec.id);
  } catch (error) {
    fail(spec.id, error);
  } finally {
    closeMock(mock);
    await context.close().catch(() => {});
  }
}

async function requestOrThrow(mock) {
  const request = await waitForRequest(mock, args.actionTimeoutMs);
  if (!request) throw new Error(`no POST /api/director within ${args.actionTimeoutMs}ms`);
  return request;
}

async function runDirectorConditions(browser, outDir) {
  await runDirectorScenario(browser, outDir, {
    id: 'director.error',
    mode: 'error',
    run: async ({ page, mock }) => {
      await requestOrThrow(mock);
      await waitForBadge(page, /director link: running local fallback content/i, args.actionTimeoutMs);
      const label = await badgeLabel(page);
      const radio = await radioText(page);
      if (/live operator connected/i.test(label)) throw new Error(`HTTP 500 was labelled live: "${label}"`);
      if (!radio.includes('FALLBACK')) throw new Error('HTTP 500 event is missing the FALLBACK tag');
      if (!/director endpoint 500/i.test(radio)) throw new Error('HTTP 500 failure reason is missing from the radio note');
      record('PASS', 'director.error', 'HTTP 500 falls back locally and is labelled FALLBACK');
    },
  });

  await runDirectorScenario(browser, outDir, {
    id: 'director.abort',
    mode: 'abort',
    run: async ({ page, mock }) => {
      await requestOrThrow(mock);
      await waitForBadge(page, /director link: running local fallback content/i, args.actionTimeoutMs);
      const label = await badgeLabel(page);
      const radio = await radioText(page);
      if (/live operator connected/i.test(label)) throw new Error(`network abort was labelled live: "${label}"`);
      if (!/unreachable|timeout|fallback/i.test(radio)) throw new Error('network abort reason is missing from the radio note');
      record('PASS', 'director.abort', 'aborted request falls back locally and is labelled FALLBACK');
    },
  });

  await runDirectorScenario(browser, outDir, {
    id: 'director.slow',
    mode: 'slow',
    run: async ({ page, mock }) => {
      await requestOrThrow(mock);
      const before = await readScene(page);
      await page.waitForTimeout(1_600);
      const during = await readScene(page);
      if (
        before.clockSeconds === null ||
        during.clockSeconds === null ||
        during.clockSeconds <= before.clockSeconds
      ) {
        throw new Error(`gameplay clock did not advance during a slow director request (${before.clockSeconds}s → ${during.clockSeconds}s)`);
      }
      await waitForBadge(page, /director link: running local fallback content/i, args.actionTimeoutMs);
      record(
        'PASS',
        'director.slow',
        `clock advanced ${before.clockSeconds}s → ${during.clockSeconds}s while the response was delayed; fallback eventually applied`,
      );
    },
  });

  if (args.skipSlow) {
    record('SKIP', 'director.timeout', 'skipped by --skip-slow');
    return;
  }

  await runDirectorScenario(browser, outDir, {
    id: 'director.timeout',
    mode: 'timeout',
    run: async ({ page, mock }) => {
      await requestOrThrow(mock);
      await waitForBadge(page, /director link: running local fallback content/i, DIRECTIVE_TIMEOUT_MS + 4_500);
      const radio = await radioText(page);
      const label = await badgeLabel(page);
      if (/live operator connected/i.test(label)) throw new Error(`timeout was labelled live: "${label}"`);
      if (!/timeout/i.test(radio)) throw new Error('timeout fallback is missing the "director timeout" note');
      record('PASS', 'director.timeout', '9s client timeout aborts the request and falls back locally');
    },
  });
}

async function runTouchSuite(browser, outDir) {
  if (args.skipTouch) {
    record('SKIP', 'touch.controls', 'skipped by --skip-touch');
    return;
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mock = installDirectorMock(context, 'fallback');
  const page = await context.newPage();
  const errors = trackPage(page, 'touch');
  diagnostics.suites.push({ label: 'touch', requests: mock.requests, errors });
  try {
    await gotoApp(page);
    await beginRun(page);

    const stick = page.getByRole('application', { name: /movement stick/i }).first();
    const touchVisible = await stick.isVisible().catch(() => false);
    if (!touchVisible) {
      record(
        'SKIP',
        'touch.controls',
        'coarse-pointer touch layer did not appear in headless emulation; cannot verify narrow-screen controls',
      );
      return;
    }
    record('PASS', 'touch.controls', 'narrow viewport reports the on-screen movement stick');

    const overlaps = await page.evaluate(() => {
      const boxes = ['.df-hud__top', '.df-vitals', '.df-flash', '.df-radio', '.df-stick', '.df-touch__btns']
        .map((selector) => ({ selector, box: document.querySelector(selector)?.getBoundingClientRect() }))
        .filter(({ box }) => box && box.width > 0 && box.height > 0);
      const collisions = [];
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        for (const b of boxes.slice(i + 1)) {
          if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1
            && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1) {
            collisions.push(`${a.selector} overlaps ${b.selector}`);
          }
        }
      }
      return collisions;
    });
    if (overlaps.length) record('FAIL', 'touch.layout', overlaps.join('; '));
    else record('PASS', 'touch.layout', 'HUD, vitals, message banner, radio, and touch controls do not overlap');

    const box = await stick.boundingBox();
    if (!box) throw new Error('movement stick has no bounding box');
    const nub = stick.locator('div').first();
    const beforeTransform = (await nub.getAttribute('style').catch(() => '')) || '';
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 38, box.y + box.height / 2 - 24, { steps: 6 });
    await page.waitForTimeout(500);
    const duringTransform = (await nub.getAttribute('style').catch(() => '')) || '';
    const frameDuring = await canvasStats(page);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const afterTransform = (await nub.getAttribute('style').catch(() => '')) || '';
    const frameAfter = await canvasStats(page);
    const drift = gridDrift(frameDuring, frameAfter);

    if (duringTransform === beforeTransform || /translate\(-50%,\s*-50%\)/.test(duringTransform)) {
      throw new Error('stick did not follow the drag');
    }
    if (!/translate\(-50%,\s*-50%\)/.test(afterTransform)) {
      throw new Error('stick did not recentre after pointer release');
    }
    record('PASS', 'touch.stick', `stick followed drag and recentred; frame drift after release ${drift?.toFixed(1) ?? '?'}%`);

    const lamp = page.getByRole('button', { name: /toggle flashlight/i }).first();
    const interact = page.getByRole('button', { name: /^interact$/i }).first();
    if ((await lamp.isVisible().catch(() => false)) && (await interact.isVisible().catch(() => false))) {
      if (await lamp.getAttribute('aria-pressed') !== 'false') throw new Error('lamp did not begin switched off');
      await lamp.click();
      await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle flashlight"]')?.getAttribute('aria-pressed') === 'true');
      await interact.click();
      await page.waitForTimeout(350);
      record('PASS', 'touch.buttons', 'LAMP toggles actual flashlight state and USE is clickable');
    } else {
      record('WARN', 'touch.buttons', 'touch action buttons were not both visible');
    }
    await screenshot(page, outDir, 'touch-narrow');
    await browserErrorCheck('touch.errors', errors, {});
  } catch (error) {
    fail('touch.controls', error);
  } finally {
    closeMock(mock);
    await context.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (args.help) {
    printUsage();
    return 0;
  }
  if (!args.baseUrl) {
    printUsage();
    throw new SetupError('missing <base-url>');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(args.baseUrl);
  } catch {
    throw new SetupError(`invalid base URL: ${args.baseUrl}`);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new SetupError('base URL must use http:// or https://');
  }

  const outDir = ensureOutDir();
  diagnostics.outDir = outDir;
  args.chromePath = findChrome();
  diagnostics.chromePath = args.chromePath;
  console.log(`Dead Frequency smoke — ${args.baseUrl}`);
  console.log(`Chrome: ${args.chromePath}`);
  console.log(`Diagnostics: ${outDir}`);
  console.log('');

  const watchdog = setTimeout(() => {
    record('FAIL', 'harness.watchdog', `run exceeded ${args.totalTimeoutMs}ms`);
    writeReport(outDir);
    process.exit(1);
  }, args.totalTimeoutMs);

  let browser = null;
  try {
    browser = await chromium.launch({
      executablePath: args.chromePath,
      headless: !args.headed,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--mute-audio',
      ],
    });

    const desktop = await runDesktopSuite(browser, outDir);
    if (desktop.engineReady && desktop.requestSeen) {
      await runDirectorConditions(browser, outDir);
    } else if (!desktop.engineReady) {
      for (const id of [
        'director.error',
        'director.abort',
        'director.slow',
        'director.timeout',
        'touch.controls',
        'touch.stick',
        'touch.buttons',
      ]) {
        record('BLOCKED', id, 'engine/HUD never mounted, so the scenario cannot run');
      }
    } else {
      for (const id of ['director.error', 'director.abort', 'director.slow', 'director.timeout']) {
        record('BLOCKED', id, 'engine did not emit a milestone director request, so mocked conditions cannot run');
      }
    }
    if (desktop.engineReady) {
      await runTouchSuite(browser, outDir);
    }
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
  }

  writeReport(outDir);
  const tally = counts();
  console.log('');
  console.log(
    `Summary: ${tally.PASS} passed, ${tally.FAIL} failed, ${tally.WARN} warnings, ${tally.SKIP} skipped, ${tally.BLOCKED} blocked`,
  );
  console.log(`Report: ${path.join(outDir, 'report.json')}`);
  return tally.FAIL > 0 || tally.BLOCKED > 0 ? 1 : 0;
}

function writeReport(outDir) {
  const tally = counts();
  const report = {
    baseUrl: args.baseUrl,
    chromePath: args.chromePath,
    startedAt: diagnostics.startedAt,
    finishedAt: new Date().toISOString(),
    command: process.argv.join(' '),
    options: args,
    tally,
    results,
    diagnostics,
    note:
      'Every POST /api/director in every context was intercepted and fulfilled with scripted data. SKIPPED/BLOCKED checks are not passes.',
  };
  try {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(outDir, 'summary.txt'),
      results.map((entry) => `[${entry.status}] ${entry.id} — ${entry.detail}`).join('\n') + '\n',
    );
  } catch (error) {
    console.error(`Could not write diagnostics: ${shortError(error)}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof SetupError) {
      console.error(`Setup error: ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error(error);
      process.exitCode = 1;
    }
  });
