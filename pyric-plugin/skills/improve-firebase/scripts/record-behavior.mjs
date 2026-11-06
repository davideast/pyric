#!/usr/bin/env node
/**
 * Behavior-finding recorder for Pyric evidence videos.
 *
 * Rules findings flip one rules file under a single sandbox. Behavior findings
 * (app-code fixes such as a sign-out ordering bug) need two app builds instead:
 * the "before" build reproduces the bug, the "after" build shows the fix. Both
 * phases are recorded into one continuous capture so render.mjs can cut the
 * same 8-slide story from it.
 *
 * Usage:
 *   node record-behavior.mjs --scenario <scenario.json> --seed <seed.json> --out <dir> [--render] [--formats mp4] [--json]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BUNDLE_SCHEMA,
  DEFAULT_VIEWPORT_DIP,
  buildLockedProvenanceText,
  validateBundleManifest,
  validateScenario,
} from './lib/contracts.mjs';
import { loadPlaywright, resolveChromiumExecutable } from './lib/runtime.mjs';
import { selectCaptureBackend } from './lib/capture/backend.mjs';
import { IsolatedSandbox } from './lib/sandbox-client.mjs';
import { signInActorPage } from './lib/identity.mjs';
import { prepareActorUiForRecording } from './record.mjs';

export class BehaviorRecordError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BehaviorRecordError';
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const opts = { render: false, formats: ['mp4'], fps: 30, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new BehaviorRecordError('INVALID_CLI_ARGS', `${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === '--scenario') opts.scenarioPath = path.resolve(next());
    else if (arg === '--seed') opts.seedPath = path.resolve(next());
    else if (arg === '--out') opts.outDir = path.resolve(next());
    else if (arg === '--render') opts.render = true;
    else if (arg === '--formats') opts.formats = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--fps') opts.fps = Number(next());
    else if (arg === '--json') opts.json = true;
    else throw new BehaviorRecordError('INVALID_CLI_ARGS', `Unknown argument "${arg}"`);
  }
  if (!opts.scenarioPath || !opts.outDir) {
    throw new BehaviorRecordError('INVALID_CLI_ARGS', 'Usage: record-behavior.mjs --scenario <file> --seed <file> --out <dir>');
  }
  return opts;
}

function writeSandboxConfig({ dist, rulesPath }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-behavior-cfg-'));
  const cfg = {
    ...(rulesPath ? { database: { rules: rulesPath } } : {}),
    hosting: { public: path.resolve(dist), rewrites: [{ source: '**', destination: '/index.html' }] },
  };
  const cfgPath = path.join(dir, 'firebase.json');
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { dir, cfgPath };
}

async function startSandbox({ dist, rulesPath, seedPath }) {
  const { dir, cfgPath } = writeSandboxConfig({ dist, rulesPath });
  const sandbox = await IsolatedSandbox.start({ projectDir: dir, firebaseConfigPath: cfgPath, seedDir: seedPath });
  return { sandbox, appUrl: sandbox.uiUrl || sandbox.url, cfgDir: dir };
}

async function presenceEntries(sandbox, checkPath) {
  const val = await sandbox.readState('database', checkPath).catch(() => null);
  return Object.entries(val || {}).map(([clientId, entry]) => ({ clientId, uid: entry?.uid ?? null }));
}

async function waitFor(fn, { timeoutMs, intervalMs = 150 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * Opens the account menu from the avatar button and clicks the sign-out item.
 * The avatar may sit inside the collapsed left nav, so the menu is opened with a
 * synthetic pointerdown (Radix opens on pointerdown) without un-hiding the nav.
 */
async function signOutViaUi(page, { triggerText, menuItemText = 'Sign out' }) {
  const found = await page.evaluate((text) => {
    const btns = [...document.querySelectorAll('button[aria-haspopup]')];
    let pick = -1;
    let visible = false;
    btns.forEach((b, i) => {
      if ((b.innerText || b.textContent || '').trim() !== text) return;
      const r = b.getBoundingClientRect();
      if (pick < 0 || (r.width > 0 && !visible)) {
        pick = i;
        visible = r.width > 0;
      }
    });
    return { pick, visible };
  }, triggerText);
  if (found.pick < 0) {
    throw new BehaviorRecordError('SIGN_OUT_TRIGGER_NOT_FOUND', `No account menu button with text "${triggerText}"`);
  }
  const trigger = page.locator('button[aria-haspopup]').nth(found.pick);
  const menuOpen = async () => (await page.locator('[role="menuitem"]').count()) > 0;
  if (found.visible) {
    await trigger.focus();
    await page.keyboard.press('Enter');
    await sleep(250);
  }
  if (!(await menuOpen())) {
    await trigger.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse', isPrimary: true });
    await sleep(250);
  }
  if (!(await menuOpen())) {
    await trigger.evaluate((el) => el.click());
    await sleep(250);
  }
  await page.locator('[role="menuitem"]', { hasText: menuItemText }).first().click({ timeout: 4000 });
}

async function measureSelectorFocus(page, selector) {
  if (!page || !selector) return null;
  return page
    .evaluate((sel) => {
      const vw = window.innerWidth || 900;
      const vh = window.innerHeight || 675;
      const el = [...document.querySelectorAll(sel)].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.closest('[data-pyric-collapsed="1"]');
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const pad = 6;
      const left = Math.max(0, r.left - pad);
      const top = Math.max(0, r.top - pad);
      const right = Math.min(vw, r.right + pad);
      const bottom = Math.min(vh, r.bottom + pad);
      return {
        vw,
        vh,
        x: Number((left / vw).toFixed(4)),
        y: Number((top / vh).toFixed(4)),
        w: Number(((right - left) / vw).toFixed(4)),
        h: Number(((bottom - top) / vh).toFixed(4)),
      };
    }, selector)
    .catch(() => null);
}

async function measureFocus(pages, focusSelectors) {
  const out = {};
  for (const [role, sel] of Object.entries(focusSelectors || {})) {
    const rect = await measureSelectorFocus(pages[role], sel);
    if (rect) out[role] = rect;
  }
  return Object.keys(out).length ? out : null;
}

async function signInAll({ pages, sandbox, appUrl, actors, collapseSidebar }) {
  for (const [role, actor] of Object.entries(actors)) {
    if (!pages[role]) continue;
    await signInActorPage({
      page: pages[role],
      sandbox,
      appUrl,
      actor: { ...actor, displayName: actor.displayName || actor.name },
    });
  }
  for (const page of Object.values(pages)) {
    await prepareActorUiForRecording(page, { targetTexts: [], collapseSidebar });
  }
}

/**
 * Record a behavior finding: reproduce on the "before" build, then show the fix on the "after" build.
 */
export async function recordBehaviorEvidence({
  scenarioPath,
  seedPath,
  outDir,
  render = false,
  formats = ['mp4'],
  fps = 30,
  log = () => {},
}) {
  const t0 = Date.now();
  const timings = {};
  const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const scenario = validateScenario(raw);
  const behavior = scenario.behavior;
  if (!behavior) throw new BehaviorRecordError('NOT_A_BEHAVIOR_SCENARIO', 'scenario.behavior is required');
  if (!scenario.app?.dist || !fs.existsSync(scenario.app.dist)) {
    throw new BehaviorRecordError('MISSING_APP_DIST', `Before build not found: ${scenario.app?.dist}`);
  }
  if (!fs.existsSync(behavior.fixApp.dist)) {
    throw new BehaviorRecordError('MISSING_FIX_DIST', `After build not found: ${behavior.fixApp.dist}`);
  }
  const rulesPath = raw.rules?.rtdb ? path.resolve(raw.rules.rtdb) : null;
  const seed = seedPath || (raw.seedFile ? path.resolve(raw.seedFile) : null);
  const check = behavior.check;
  const actorRole = behavior.action.actor || 'victim';
  const observerRole = actorRole === 'victim' ? 'attacker' : 'victim';
  const actor = scenario.actors[actorRole];
  const checkUid = check.uid || actor.uid;
  const waitMs = Number(check.waitMs) || 3000;
  const triggerText = behavior.action.triggerText || String(actor.name || actor.uid).trim().charAt(0).toUpperCase();
  const collapseSidebar = scenario.stage?.slots?.collapseSidebar !== false;
  const focusSelectors = behavior.focusSelectors || {};

  const bundleDir = path.join(outDir, scenario.finding.probe);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  const events = [];
  const uiFocus = {};
  let before = null;
  let after = null;
  let captureBackend = null;
  let captureArtifact = null;

  try {
    before = await startSandbox({ dist: scenario.app.dist, rulesPath, seedPath: seed });
    timings.sandboxBeforeSec = (Date.now() - t0) / 1000;
    log(`before sandbox: ${before.appUrl}`);

    const pw = await loadPlaywright({ projectDir: process.cwd(), log });
    captureBackend = selectCaptureBackend({ backend: 'auto' });
    const started = await captureBackend.start({
      actors: scenario.actors,
      outputDir: bundleDir,
      viewport: scenario.stage?.viewport || DEFAULT_VIEWPORT_DIP,
      fps,
      chromium: pw.chromium,
      executablePath: resolveChromiumExecutable(pw.chromium),
    });
    const pages = started.pages || {};
    const captureStart = performance.now();
    const nowMs = () => Math.round(performance.now() - captureStart);

    // Phase 1: before build
    await signInAll({ pages, sandbox: before.sandbox, appUrl: before.appUrl, actors: scenario.actors, collapseSidebar });
    // Both views are signed in and prepared; attach-demo starts after this.
    const uiReadyAtMs = nowMs();
    const presentBefore = await waitFor(
      async () => {
        const entries = await presenceEntries(before.sandbox, check.path);
        const uids = entries.map((e) => e.uid);
        return Object.values(scenario.actors).every((a) => uids.includes(a.uid)) ? entries : null;
      },
      { timeoutMs: 15000 },
    );
    if (!presentBefore) {
      throw new BehaviorRecordError('GATE_G2_FAILED', `Both actors never appeared under ${check.path} on the before build`);
    }
    await sleep(900);
    uiFocus.control = await measureFocus(pages, focusSelectors);
    const clientId = presentBefore.find((e) => e.uid === checkUid)?.clientId || '$clientId';
    events.push({
      phase: 'control',
      tMs: nowMs(),
      dispatchedAtMs: nowMs(),
      executedAtMs: nowMs(),
      settledAtMs: nowMs(),
      actor: actor.uid,
      actorLabel: actor.uid,
      service: 'database',
      method: 'onValue',
      path: check.path,
      decision: 'PRESENT',
      uiReadyAtMs,
    });
    uiFocus.exploitPre = uiFocus.control;
    timings.beforeReadySec = (Date.now() - t0) / 1000;

    const exDispatch = nowMs();
    await signOutViaUi(pages[actorRole], { triggerText, menuItemText: behavior.action.menuItemText });
    const exExec = nowMs();
    await sleep(waitMs);
    const leftover = (await presenceEntries(before.sandbox, check.path)).some((e) => e.uid === checkUid);
    const exSettled = nowMs();
    if (!leftover) {
      throw new BehaviorRecordError(
        'GATE_G3_FAILED',
        `Bug did not reproduce: ${checkUid}'s presence entry was removed on the before build`,
      );
    }
    await prepareActorUiForRecording(pages[observerRole], { targetTexts: [], collapseSidebar });
    uiFocus.exploitPost = await measureFocus(pages, focusSelectors);
    const exploitPath = `${check.path}/${clientId}`;
    events.push({
      phase: 'exploit',
      tMs: exDispatch,
      dispatchedAtMs: exDispatch,
      executedAtMs: exExec,
      settledAtMs: exSettled,
      actor: actor.uid,
      actorLabel: actor.uid,
      service: 'auth',
      method: 'signOut',
      path: exploitPath,
      decision: 'LEFT BEHIND',
      observedAfterMs: waitMs,
    });
    timings.beforeDoneSec = (Date.now() - t0) / 1000;

    // Phase 2: after build, same windows, same capture
    after = await startSandbox({ dist: behavior.fixApp.dist, rulesPath, seedPath: seed });
    log(`after sandbox: ${after.appUrl}`);
    await signInAll({ pages, sandbox: after.sandbox, appUrl: after.appUrl, actors: scenario.actors, collapseSidebar });
    const presentAfter = await waitFor(
      async () => {
        const uids = (await presenceEntries(after.sandbox, check.path)).map((e) => e.uid);
        return Object.values(scenario.actors).every((a) => uids.includes(a.uid));
      },
      { timeoutMs: 15000 },
    );
    if (!presentAfter) {
      throw new BehaviorRecordError('GATE_G5_FAILED', `Both actors never appeared under ${check.path} on the after build`);
    }
    await sleep(700);
    uiFocus.fixPre = await measureFocus(pages, focusSelectors);
    const fxDispatch = nowMs();
    await signOutViaUi(pages[actorRole], { triggerText, menuItemText: behavior.action.menuItemText });
    const removedAt = await waitFor(
      async () => ((await presenceEntries(after.sandbox, check.path)).some((e) => e.uid === checkUid) ? null : nowMs()),
      { timeoutMs: waitMs, intervalMs: 80 },
    );
    if (!removedAt) {
      throw new BehaviorRecordError('GATE_G5_FAILED', `${checkUid}'s presence entry was still present on the after build`);
    }
    await sleep(1400);
    const fxSettled = nowMs();
    uiFocus.fixPost = await measureFocus(pages, focusSelectors);
    events.push({
      phase: 'fix',
      tMs: fxDispatch,
      dispatchedAtMs: fxDispatch,
      executedAtMs: removedAt,
      settledAtMs: fxSettled,
      actor: actor.uid,
      actorLabel: actor.uid,
      service: 'auth',
      method: 'signOut',
      path: exploitPath,
      decision: 'REMOVED',
      removedAfterMs: removedAt - fxDispatch,
    });
    timings.afterDoneSec = (Date.now() - t0) / 1000;

    captureArtifact = await captureBackend.stop();
    captureBackend = null;

    const provenanceText = buildLockedProvenanceText({
      decision: 'LEFT BEHIND',
      fixedDecision: 'REMOVED',
      service: 'auth',
      method: 'signOut',
      path: exploitPath,
      actorLabel: actor.uid,
    });

    fs.writeFileSync(path.join(bundleDir, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
    fs.writeFileSync(path.join(bundleDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`);
    fs.writeFileSync(
      path.join(bundleDir, 'evidence.json'),
      `${JSON.stringify(
        {
          service: 'auth',
          method: 'signOut',
          path: exploitPath,
          decision: 'LEFT BEHIND',
          fixedDecision: 'REMOVED',
          before: { presentAfterSignOut: true },
          after: { presentAfterSignOut: false, removedAfterMs: removedAt - fxDispatch },
          changedPaths: [exploitPath],
          matchedRule: 'app sign-out order',
          events,
          uiFocus,
        },
        null,
        2,
      )}\n`,
    );
    const manifest = validateBundleManifest({
      schema: BUNDLE_SCHEMA,
      status: 'reproduced',
      finding: scenario.finding,
      backend: captureArtifact?.backend || 'unknown',
      platform: process.platform,
      provenanceText,
      gates: { g1: true, g2: true, g3: true, g4: true, g5: true, g6: false },
      artifacts: {
        poster: 'pending-render.png',
        scenario: 'scenario.json',
        events: 'events.json',
        evidence: 'evidence.json',
        rawCapture: 'raw/capture.json',
      },
      recordedAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    timings.recordSec = (Date.now() - t0) / 1000;
  } finally {
    if (captureBackend) await captureBackend.dispose().catch(() => {});
    if (before) await before.sandbox.dispose().catch(() => {});
    if (after) await after.sandbox.dispose().catch(() => {});
    for (const s of [before, after]) {
      if (s?.cfgDir) fs.rmSync(s.cfgDir, { recursive: true, force: true });
    }
  }

  let rendered = null;
  if (render) {
    const tRender = Date.now();
    const { renderEvidenceBundle } = await import('./render.mjs');
    rendered = await renderEvidenceBundle({ evidenceDir: bundleDir, formats, fps, log });
    timings.renderSec = (Date.now() - tRender) / 1000;
  }
  timings.totalSec = (Date.now() - t0) / 1000;
  return { ok: true, bundleDir, events, timings, ...(rendered ? { videoPath: path.join(bundleDir, 'video.mp4') } : {}) };
}

async function main() {
  let cli;
  try {
    cli = parseArgs(process.argv.slice(2));
    const result = await recordBehaviorEvidence({
      ...cli,
      log: (msg) => {
        if (!cli.json) process.stderr.write(`${msg}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: err?.code || 'RECORD_ERROR', message: err?.message || String(err) } }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

const isDirectEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  await main();
}
