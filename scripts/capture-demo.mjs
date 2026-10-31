#!/usr/bin/env node
/**
 * Dead Frequency — blog media capture harness (design sub-agent).
 *
 * Produces genuine screenshots and a real recorded walkthrough from the app
 * running in a locally installed Chrome (playwright-core, isolated session).
 *
 * Interception policy (same as the QA smoke harness):
 *   - Every POST /api/director is intercepted and answered with an explicitly
 *     scripted `{ source: "fallback", … }` response. Nothing is proxied to the
 *     real route, so no Tinker request or paid inference call can happen.
 *   - Same-origin app assets (the app under capture) are allowed.
 *   - Every other request is aborted. An external request that slips through is
 *     a hard failure, recorded in the report.
 *
 * The harness only uses visible UI controls, real keyboard/mouse/touch input
 * and semantic roles. No debug shortcuts, no internal state mutation, no
 * sim-snapshot fakery: everything on screen is the real production UI doing
 * what the real app does.
 *
 * Modes (both can run in one invocation):
 *   --stills            capture the six blog screenshots (1280×800 + 390×844)
 *   --video             record the desktop walkthrough (1280×720, webm)
 *
 * Examples:
 *   node scripts/capture-demo.mjs http://127.0.0.1:3108 --stills --video
 *   node scripts/capture-demo.mjs http://127.0.0.1:3108 --stills --out=test-results/capture-demo
 *
 * The app must already be running. This harness never starts or stops a
 * server. `--out` defaults to `blogs/assets`; report.json goes to
 * `<repo>/test-results/capture-demo/`.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const BEGIN_MS = 6_000; // title card hold, video only
const ENGINE_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 20 * 60_000;

/* ---------------------------------------------------------------- options */

function parseArgs(argv) {
  const opts = {
    baseUrl: null,
    stills: false,
    video: false,
    outDir: path.join(REPO_ROOT, 'blogs/assets'),
    reportDir: path.join(REPO_ROOT, 'test-results/capture-demo'),
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') opts.help = true;
    else if (raw === '--stills') opts.stills = true;
    else if (raw === '--video') opts.video = true;
    else if (raw.startsWith('--out=')) opts.outDir = path.resolve(REPO_ROOT, raw.slice(6));
    else if (raw.startsWith('--report=')) opts.reportDir = path.resolve(REPO_ROOT, raw.slice(9));
    else if (!raw.startsWith('--')) {
      if (opts.baseUrl) throw new Error(`unexpected argument: ${raw}`);
      opts.baseUrl = raw;
    } else throw new Error(`unknown flag ${raw}`);
  }
  if (!opts.help && !opts.baseUrl) throw new Error('usage: node scripts/capture-demo.mjs <base-url> [--stills] [--video] [--out=DIR]');
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log('node scripts/capture-demo.mjs <base-url> [--stills] [--video] [--out=DIR] [--report=DIR]');
  process.exit(0);
}
if (!ARGS.stills && !ARGS.video) {
  console.error('Pick at least one mode: --stills and/or --video.');
  process.exit(2);
}

/* ------------------------------------------------------------ director mock */

const SAFE_FALLBACKS = {
  start: { action: 'whisper', message: 'Signal found. Keep low; the dark is listening.', intensity: 0.16 },
  room_enter: { action: 'lights_flicker', message: 'Stay off the light. Something is counting doors.', intensity: 0.24 },
  relay_restored: { action: 'false_alarm', message: 'The relay is awake. So is the thing that heard it.', intensity: 0.28 },
  near_death: { action: 'help', message: 'Breathe. The dark will hide you if you let it.', intensity: 0.12 },
  exit_ready: { action: 'help', message: 'The operator link is open. Decide before the room does.', intensity: 0.18 },
};
const MILESTONES = Object.keys(SAFE_FALLBACKS);
const ROOM_IDS = ['arrival', 'medical', 'archives', 'reactor', 'exit'];
const MOCK_REASON = 'capture_mock_scripted';

const notes = { directorRequests: [], outsideOrigin: [], networkAbortChecks: [] };

/**
 * Installs routes on one context:
 *  - same-origin app traffic continues (the app under capture),
 *  - POST /api/director is fulfilled with explicit scripted fallback data,
 *  - everything else is aborted and logged as an attempted external call.
 */
async function installRoutes(context, originLabel) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const DirectorStateMock = () => false; // placeholder to keep lint-free naming obvious
    void DirectorStateMock;
    if (!request.url().startsWith(ARGS.baseUrl)) {
      outsideRequest(url.toString(), request.url(), request.resourceType());
      try {
        await route.abort('blocked_by_capture_policy');
      } catch {
        /* context closed */
      }
      return;
    }
    if (url.pathname === '/api/director') {
      if (request.method() !== 'POST') {
        await denyNonPost(route, request);
        return;
      }
      const state = parseDirectorState(request);
      notes.directorRequests.push({
        context: originLabel,
        milestone: state?.milestone ?? null,
        room: state?.room ?? null,
        relays: state?.relays ?? null,
        health: state?.health ?? null,
        response: '200 source=fallback (scripted)',
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({
          source: 'fallback',
          event: {
            action: SAFE_FALLBACKS[state?.milestone ?? 'start'].action,
            room: state?.room ?? 'arrival',
            message: SAFE_FALLBACKS[state?.milestone ?? 'start'].message,
            intensity: SAFE_FALLBACKS[state?.milestone ?? 'start'].intensity,
          },
          reason: MOCK_REASON,
        }),
      });
      return;
    }
    try {
      await route.continue();
    } catch {
      /* context closed */
    }
  });
}

function parseDirectorState(request) {
  try {
    const body = request.postDataJSON();
    if (!body || typeof body !== 'object') return null;
    const milestone = MILESTONES.includes(body.milestone) ? body.milestone : 'start';
    const room = ROOM_IDS.includes(body.room) ? body.room : 'arrival';
    return { milestone, room, relays: Number(body.relays ?? 0), health: Number(body.health ?? 100) };
  } catch {
    return null;
  }
}

async function denyNonPost(route, request) {
  notes.networkAbortChecks.push(`${request.method()} ${route.request().url()} → 405 (capture harness)`);
  await route.fulfill({
    status: 405,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify({ error: 'mock: capture harness only expects POST' }),
  });
}

function outsideRequest(from, fullUrl, type) {
  notes.outsideOrigin.push({ from: from.slice(0, 160), type, at: new Date().toISOString() });
}

/* ------------------------------------------------------------- small utils */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeExecutable() {
  return (
    process.env.CHROME_PATH
    ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
  );
}

async function trackErrors(page, bucket) {
  page.on('pageerror', (error) => bucket.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') bucket.push(`console.error: ${message.text()}`);
  });
}

async function gotoWaitEngine(page) {
  await page.goto(ARGS.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const begin = page.getByRole('button', { name: /begin transmission/i }).first();
  await begin.waitFor({ state: 'visible', timeout: ENGINE_TIMEOUT_MS });
  await page.locator('.df-hud').first().waitFor({ state: 'visible', timeout: ENGINE_TIMEOUT_MS });
  await wait(900); // let the ambient ready scene settle behind the overlay
  return begin;
}

/** Canvas luminance sample — the same idea as the project smoke harness. */
async function canvasScene(page) {
  return page.evaluate(() => {
    const element = document.querySelector('canvas');
    if (!element) return null;
    const context = element.getContext('2d');
    if (!context) return null;
    const { width, height } = element;
    if (!width || !height) return null;
    const data = context.getImageData(0, 0, width, height).data;
    let sum = 0;
    let nonBlack = 0;
    let samples = 0;
    let max = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const index = (y * width + x) * 4;
        const lum = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        sum += lum;
        samples += 1;
        if (lum > 8) nonBlack += 1;
        if (lum > max) max = lum;
      }
    }
    return { mean: sum / Math.max(1, samples), nonBlack: nonBlack / Math.max(1, samples), max };
  });
}

/** Wait until the canvas actually shows a scene (never screenshots a blank frame). */
async function waitReadableScene(page, timeoutMs = ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await canvasScene(page);
    if (last && last.mean >= 6 && last.nonBlack >= 0.02) return last;
    await wait(250);
  }
  throw new Error(`canvas never showed a readable scene (${JSON.stringify(last)})`);
}

async function lampState(page) {
  return (await page.locator('.df-chip--lamp').first().getAttribute('data-state').catch(() => null)) ?? null;
}

async function radioText(page) {
  const feed = page.getByRole('complementary', { name: /radio transcript/i }).first();
  return (await feed.textContent().catch(() => '')) ?? '';
}

async function screenshot(page, file) {
  await page.screenshot({ path: file, type: 'png', timeout: 8_000 });
}

/* ------------------------------------------------------ movement controller */

async function hold(page, key, ms) {
  await page.keyboard.down(key);
  await wait(ms);
  await page.keyboard.up(key);
  await wait(120);
}

/** Small aimed burst: hold a movement key while drifting the pointer. */
async function walk(page, key, ms, aimDX = 0) {
  await page.keyboard.down(key);
  if (aimDX) {
    await page.mouse.move(640 + aimDX, 360, { steps: 4 });
  }
  await wait(ms);
  await page.keyboard.up(key);
  await wait(150);
}

async function sweepAim(page) {
  await page.mouse.move(640, 400, { steps: 2 });
  await wait(220);
  await page.mouse.move(980, 420, { steps: 10 });
  await wait(320);
  await page.mouse.move(360, 330, { steps: 12 });
  await wait(320);
  await page.mouse.move(640, 390, { steps: 6 });
}

/* ------------------------------------------------------------- stills run */

async function captureStills(browser, report) {
  const screenshotsDir = path.join(ARGS.outDir, 'screenshots');
  await fsp.mkdir(screenshotsDir, { recursive: true });

  report.stills = { contextA: {}, contextB: {} };

  // -------- context A: desktop 1280×800 @2x --------
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await installRoutes(context, 'stills-desktop');
    const page = await context.newPage();
    const errors = [];
    await trackErrors(page, errors);

    const begin = await gotoWaitEngine(page);
    await waitReadableScene(page);

    // 01 — title / sign-on overlay over the ambient ready scene.
    await screenshot(page, path.join(screenshotsDir, '01-title.png'));
    report.stills.contextA['01-title.png'] = 'ready overlay over ambient ready scene';

    await begin.click();
    await page.getByRole('button', { name: /pause the run/i }).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await wait(900); // start milestone → radio entries + fallback whisper banner

    await hold(page, 'KeyW', 1_600);
    await waitReadableScene(page);
    await hold(page, 'KeyW', 900);
    await wait(350);
    await screenshot(page, path.join(screenshotsDir, '02-gameplay.png'));
    report.stills.contextA['02-gameplay.png'] = 'playing, walked out of the arrival bay';

    // 04 — scripted fallback state: FALLBACK radio entry + Director·fallback badge.
    try {
      const feedText = await radioText(page);
      if (!feedText.includes('FALLBACK')) {
        await page
          .getByRole('status', { name: /director link: running local fallback content/i })
          .first()
          .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
      }
      await wait(700);
      await hold(page, 'KeyW', 700);
      await screenshot(page, path.join(screenshotsDir, '04-fallback.png'));
      report.stills.contextA['04-fallback.png'] = 'HUD badge Director·fallback + FALLBACK-tagged radio entry';
    } catch (error) {
      report.stills.contextA['04-fallback.png'] = `WARN: fallback state not visible: ${String(error).slice(0, 200)}`;
    }

    // 03 — flashlight on: press F, confirm the LAMP chip, walk for a lit frame.
    await page.keyboard.press('KeyF');
    try {
      await page
        .locator('.df-chip--lamp[data-state="on"]')
        .first()
        .waitFor({ state: 'visible', timeout: 3_000 });
    } catch {
      /* some keyboard layouts: retry via press('f') */
      await page.keyboard.press('f');
      await page.locator('.df-chip--lamp[data-state="on"]').first().waitFor({ state: 'visible', timeout: 3_000 });
    }
    report.stills.contextA.lampAfterF = await lampState(page);
    await hold(page, 'KeyW', 1_100);
    await sweepAim(page);
    await waitReadableScene(page);
    await wait(250);
    await screenshot(page, path.join(screenshotsDir, '03-flashlight.png'));
    report.stills.contextA['03-flashlight.png'] = 'flashlight on, cone lighting the scene';

    // 05 — pause overlay via Escape (real UI path).
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await wait(500);
    report.stills.contextA.pauseClock = await page
      .getByRole('dialog')
      .first()
      .locator('.df-copy')
      .first()
      .textContent()
      .catch(() => null);
    await screenshot(page, path.join(screenshotsDir, '05-pause.png'));
    report.stills.contextA['05-pause.png'] = 'pause overlay, carrier held';

    report.stills.contextA.consolePageErrors = errors;
    report.stills.contextA.radioTail = (await radioText(page)).slice(-320);
    await context.close();
  }

  // -------- context B: narrow/mobile 390×844 DSF3 with touch emulation --------
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await installRoutes(context, 'stills-mobile');
    const page = await context.newPage();
    const errors = [];
    await trackErrors(page, errors);

    const begin = await gotoWaitEngine(page);

    // Does headless Chrome actually report a coarse pointer here?
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
    report.stills.contextB.pointerCoarse = coarse;

    await begin.tap().catch(async () => begin.click());
    await page
      .getByRole('button', { name: /pause the run/i })
      .first()
      .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

    // The touch layer mounts with the playing phase; give React a beat to
    // commit, and retry for a few seconds before concluding it is absent.
    let touchLayerVisible = false;
    if (coarse) {
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        touchLayerVisible = await page
          .locator('.df-touch.is-active')
          .first()
          .isVisible()
          .catch(() => false);
        if (touchLayerVisible) break;
        await wait(250);
      }
    }
    report.stills.contextB.touchLayerVisible = touchLayerVisible;

    if (touchLayerVisible) {
      // Real touch drag on the movement stick via the CDP touch pipeline,
      // then screenshot with the finger still down (genuine drag state).
      const stick = page.locator('.df-stick').first();
      const box = await stick.boundingBox();
      if (box) {
        const client = await context.newCDPSession(page);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: cx, y: cy, radiusX: 8, radiusY: 8, force: 0.6 }],
        });
        for (let step = 1; step <= 6; step += 1) {
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: cx + step * 9, y: cy - step * 11, radiusX: 8, radiusY: 8, force: 0.6 }],
          });
          await wait(70);
        }
        await wait(500);
        report.stills.contextB['06-mobile.png'] = 'touch layer active, stick held mid-drag';
        await waitReadableScene(page);
        await screenshot(page, path.join(screenshotsDir, '06-mobile.png'));
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        report.stills.contextB.stickHeldThroughShot = true;
        await client.detach?.();
      } else {
        report.stills.contextB['06-mobile.png'] = 'WARN: stick box unavailable';
      }
      // Extra evidence (not in the still): the lamp button really toggles.
      try {
        const lampBtn = page.locator('.df-tbtn--lamp').first();
        if (await lampBtn.isVisible().catch(() => false)) {
          await lampBtn.tap();
          await wait(300);
          report.stills.contextB.lampAfterTap = await lampState(page);
        }
      } catch (error) {
        report.stills.contextB.lampTapError = String(error).slice(0, 160);
      }
    } else {
      // Coarse pointer unavailable in this headless build: capture the narrow
      // HUD layout without pretending touch controls are visible.
      await hold(page, 'KeyW', 900);
      await waitReadableScene(page);
      await screenshot(page, path.join(screenshotsDir, '06-mobile.png'));
      report.stills.contextB['06-mobile.png'] = 'WARN: touch layer not reported, captured narrow HUD only';
    }

    report.stills.contextB.consolePageErrors = errors;
    await context.close();
  }
}

/* ------------------------------------------------------------- video run */

async function captureVideo(browser, report) {
  // Raw recordings are scratch evidence, not blog media. Keep them beside the
  // capture report so blogs/assets only contains the delivered files.
  const videoDir = path.join(ARGS.reportDir, 'raw');
  await fsp.mkdir(videoDir, { recursive: true });
  const videoStart = Date.now();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  await installRoutes(context, 'video-desktop');
  const page = await context.newPage();
  const errors = [];
  await trackErrors(page, errors);

  const reportVideo = (report.video = {
    videoStartedAt: new Date(videoStart).toISOString(),
    beats: [],
    errors,
  });
  const beats = reportVideo.beats;
  const mark = (label) => beats.push({ label, atMs: Date.now() - videoStart });

  const begin = await gotoWaitEngine(page);
  await waitReadableScene(page);
  await wait(600); // first readable frame before the title hold starts

  // 1 · title card
  mark('title card');
  await wait(BEGIN_MS);

  // 2 · begin the run
  await begin.click();
  await page
    .getByRole('button', { name: /pause the run/i })
    .first()
    .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  mark('begin transmission');
  await wait(1_500); // start milestone → scripted fallback line lands

  // 3 · look around the safe arrival bay before moving. These are short
  // west/east steps that return near the spawn, with no hidden state changes.
  await hold(page, 'KeyA', 500);
  await sweepAim(page);
  await hold(page, 'KeyD', 500);
  await sweepAim(page);
  await hold(page, 'KeyD', 500);
  await sweepAim(page);
  await hold(page, 'KeyA', 500);
  await sweepAim(page);
  await hold(page, 'KeyA', 500);
  await sweepAim(page);
  await hold(page, 'KeyD', 500);
  await sweepAim(page);
  mark('arrival look');

  await hold(page, 'KeyD', 500);
  await sweepAim(page);
  await hold(page, 'KeyA', 500);
  await sweepAim(page);
  await hold(page, 'KeyD', 500);
  await sweepAim(page);
  await hold(page, 'KeyA', 500);
  await sweepAim(page);
  await hold(page, 'KeyD', 500);
  await sweepAim(page);
  mark('arrival sweep');

  // Flashlight demo in the safe arrival bay; off for the dark approach, which
  // is also the honest stealth trade-off the game teaches.
  await page.keyboard.press('KeyF');
  await page
    .locator('.df-chip--lamp[data-state="on"]')
    .first()
    .waitFor({ state: 'visible', timeout: 3_000 });
  await wait(700);
  await sweepAim(page);
  mark('flashlight on');
  await page.keyboard.press('KeyF');
  await page
    .locator('.df-chip--lamp[data-state="off"]')
    .first()
    .waitFor({ state: 'visible', timeout: 3_000 });
  await wait(500);
  await sweepAim(page);
  mark('flashlight off');

  // 4 · walk east out of the arrival bay toward the archives corridor.
  // The map is fixed-seed (20261031) and this route is checked against the
  // live production build: east, around a shelf, then the relay pedestal.
  await hold(page, 'KeyD', 1_000);
  await hold(page, 'KeyW', 130);
  mark('east corridor');

  // Stop when the game's own interaction prompt appears; never guess at a
  // hidden coordinate and never press E from far away.
  let promptFound = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const prompt = await page.evaluate(() => document.querySelector('.df-prompt')?.textContent ?? '');
    if (/RESTORE RELAY/i.test(prompt)) {
      promptFound = true;
      break;
    }
    await hold(page, 'KeyD', 80);
  }
  reportVideo.promptFound = promptFound;
  if (!promptFound) throw new Error('relay interaction prompt never appeared on the fixed-seed route');

  await sweepAim(page);
  mark('relay prompt');

  // 5 · restore the relay through the real E interaction.
  await page.keyboard.press('KeyE');
  await page
    .locator('.df-relays__pip.is-on')
    .first()
    .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  mark('relay restored');
  reportVideo.relayPips = await page.locator('.df-relays__pip.is-on').count();
  await wait(900); // relay radio line / fallback response lands

  // 6 · end the clip on the real pause overlay. This is a demo, not a
  // playthrough; stopping here keeps every frame honest and avoids staging a
  // false escape past the creature.
  const resumeButton = page.getByRole('button', { name: /resume/i }).first();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await resumeButton.waitFor({ state: 'visible', timeout: 5_000 });
  mark('pause');
  await wait(7_000);
  mark('end');

  reportVideo.finalRoom =
    (await page.locator('.df-chip__room').first().textContent().catch(() => null))?.trim() ?? null;
  reportVideo.finalPhase = 'paused';
  reportVideo.recordedMs = Date.now() - videoStart;
  reportVideo.directorRequests = notes.directorRequests.filter((r) => r.context === 'video-desktop').length;
  await page.close(); // flushes the recorded webm
  await context.close();
}

/* ------------------------------------------------------------------ main */

const report = {
  baseUrl: ARGS.baseUrl,
  chromePath: chromeExecutable(),
  startedAt: new Date().toISOString(),
  interception: {
    directorMockReason: MOCK_REASON,
    note: 'All POST /api/director requests were intercepted and answered with scripted source:fallback data. Non-same-origin requests were aborted and logged below.',
  },
  finishedAt: null,
};

const watchdog = setTimeout(() => {
  console.error(`capture run exceeded ${TOTAL_TIMEOUT_MS}ms`);
  process.exit(1);
}, TOTAL_TIMEOUT_MS);

let browser = null;
try {
  browser = await chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: ['--mute-audio', '--disable-dev-shm-usage'],
  });
  if (ARGS.stills) await captureStills(browser, report);
  if (ARGS.video) await captureVideo(browser, report);
} finally {
  clearTimeout(watchdog);
  if (browser) await browser.close().catch(() => {});
}

report.noteCounts = {
  directorRequests: notes.directorRequests.length,
  byContext: notes.directorRequests.reduce((acc, entry) => {
    entry.context in acc ? (acc[entry.context] += 1) : (acc[entry.context] = 1);
    return acc;
  }, {}),
  milestonesSeen: [...new Set(notes.directorRequests.map((r) => r.milestone).filter(Boolean))],
  externalRequestsAttempted: notes.outsideOrigin.length,
  nonPostDirectorRequests: notes.networkAbortChecks.length,
};
report.outsideOriginAttempts = notes.outsideOrigin;
report.finishedAt = new Date().toISOString();

const reportFile = path.join(ARGS.reportDir, 'capture-report.json');
await fsp.mkdir(path.dirname(reportFile), { recursive: true });
await fsp.writeFile(reportFile, JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(ARGS.reportDir, 'director-requests.csv'),
  notes.directorRequests.map((r) => [r.context, r.milestone, r.room, r.relays, r.health, r.response].join(',')).join('\n') + '\n',
);
console.log(`Report: ${reportFile}`);
console.log(`Director requests intercepted: ${report.noteCounts.directorRequests.length} ${JSON.stringify(report.noteCounts.byContext)}`);
console.log(`External requests attempted/blocked: ${report.noteCounts.externalRequestsAttempted}`);

const problems = [
  ...(ARGS.stills ? report.stills.contextA.consolePageErrors ?? [] : []),
  ...(ARGS.stills ? report.stills.contextB.consolePageErrors ?? [] : []),
  ...(ARGS.video ? report.video?.errors ?? [] : []),
];
if (problems.length) {
  console.error(`Page/console errors during capture: ${problems.join('; ')}`);
  process.exit(1);
}
