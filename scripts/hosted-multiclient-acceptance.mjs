/** Gate 6B workload. Short smoke runs are explicitly not acceptance runs. */
import { runBrowserWorkload, summarizeBrowserWorkloads } from './diagnostics/multiclient-workload.mjs';
import { verifyHistoryCountBoundary } from './diagnostics/multiclient-history.mjs';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const { WebSocket } = createRequire(new URL('../packages/cli/package.json', import.meta.url))('ws');
const smoke = process.env.PYRIC_MULTICLIENT_SMOKE === '1';
const diagnostic = process.env.PYRIC_MULTICLIENT_DIAGNOSTIC === '1';
const detailed = diagnostic && process.env.PYRIC_MULTICLIENT_PROFILE === '1';
function diagnosticInteger(name, fallback, minimum, maximum) {
  const supplied = process.env[name];
  if (supplied === undefined) return fallback;
  if (!diagnostic) throw new Error(`${name} is diagnostic-only; acceptance settings are fixed.`);
  const value = Number(supplied);
  const valid = Number.isInteger(value) && value >= minimum && value <= maximum;
  if (!valid) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
const warmupMs = diagnosticInteger('PYRIC_MULTICLIENT_WARMUP_SECONDS', diagnostic ? 30 : smoke ? 5 : 120, 1, 120) * 1000;
const durationMs = diagnosticInteger('PYRIC_MULTICLIENT_SECONDS', diagnostic ? 60 : smoke ? 15 : 900, 1, 900) * 1000;
const rate = diagnosticInteger('PYRIC_MULTICLIENT_RATE', 100, 4, 100);
const coldDocuments = diagnosticInteger('PYRIC_MULTICLIENT_COLD_DOCUMENTS', 0, 0, 3000);
const documentCount = 1000 + coldDocuments;
const output = process.env.PYRIC_MULTICLIENT_OUTPUT ?? '/tmp/pyric-multiclient-acceptance.json';
const project = mkdtempSync(join(tmpdir(), 'pyric-multiclient-'));
const samples = [];
const windows = [];
const contexts = [];
const pages = [];
const errors = [];
const environment = { node: process.version, cpu: cpus()[0].model, memoryBytes: totalmem(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
const result = { environment, smoke, diagnostic, detailed, coldDocuments, warmupMs, durationMs, clients: 4, subscriptionsPerClient: 20,
  operationsPerSecond: rate, documents: documentCount, documentJsonBytes: 1024, samples, windows, errors };
function save() { writeFileSync(output, JSON.stringify(result, null, 2)); }
writeFileSync(join(project, 'index.html'), '<!doctype html><title>Multi-client acceptance</title><p id="status">Starting</p><script type="module" src="/main.js"></script>');
writeFileSync(join(project, 'main.js'), `import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
await signInAnonymously(getAuth());
document.querySelector('#status').textContent = 'Ready';`);
const profilePath = `${output}.cpuprofile`;
const child = spawn(process.execPath, [join(root, 'packages/cli/dist/cli/index.js'), 'sandbox', '--hosted', '--bridge', '--no-open', '--port', '0', '--json', '--no-cache'], {
  cwd: project, env: { ...process.env, CI: '1', PYRIC_MULTICLIENT_PROFILE: detailed ? '1' : '0', PYRIC_MULTICLIENT_PROFILE_OUTPUT: profilePath, NODE_OPTIONS: `--import=${join(root, 'scripts/diagnostics/multiclient-host.mjs')}` },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
result.hostPid = child.pid;
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', value => { stdout = (stdout + value).slice(-65536); });
child.stderr.setEncoding('utf8').on('data', value => { stderr = (stderr + value).slice(-65536); });
const exited = new Promise(resolve => child.once('close', resolve));
let safetyAbort;
let acknowledgePhase;
const diskLimitBytes = diagnostic ? 512 * 1024 * 1024 : Infinity;
function diskBytes() {
  const storage = join(project, '.pyric/state/hosted');
  try { return readdirSync(storage).reduce((sum, name) => sum + statSync(join(storage, name)).size, 0); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
child.on('message', sample => {
  if (sample.type === 'phase-ready') { acknowledgePhase?.(sample); return; }
  if (sample.type === 'observer-refused') {
    const isStalledObserver = sample.remotePort === stalled?._socket?.localPort;
    if (isStalledObserver) {
      result.stalledRefusal = sample;
      // The host has refused this reader. Drain its close frame before ws's handshake timeout.
      stalled.resume();
    }
    return;
  }
  if (sample.type !== 'sample') return;
  sample.diskBytes = diskBytes();
  samples.push(sample);
  const memoryUnsafe = sample.memory.rss > 1536 * 1024 * 1024;
  const diskUnsafe = sample.diskBytes > diskLimitBytes;
  const unsafe = memoryUnsafe || diskUnsafe;
  if (unsafe) { safetyAbort = memoryUnsafe ? 'Host RSS exceeded 1.5 GiB; run incomplete.' : 'Temporary database exceeded 512 MiB; run incomplete.'; child.kill('SIGTERM'); }
});
const watchdog = setTimeout(() => child.kill('SIGKILL'), warmupMs + durationMs + 180_000);
let browser;
let stalled;
let stalledClose;
let phase = 'startup';
const progress = setInterval(() => {
  const sample = samples.at(-1);
  console.log(JSON.stringify({ phase, at: new Date().toISOString(), memoryMiB: sample ? Math.round(sample.memory.rss / 1048576) : null,
    captureAgeMs: sample?.capture.pendingAgeMs, windows: windows.length, error: safetyAbort }));
  save();
}, 30_000);
async function setPhase(value) {
  phase = value;
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      acknowledgePhase = message => message.error ? reject(new Error(message.error)) : resolve();
      timeout = setTimeout(() => reject(new Error(`Phase transition timed out: ${phase}`)), 10_000);
      child.send({ type: 'phase', phase });
    });
  } finally { clearTimeout(timeout); acknowledgePhase = undefined; }
}
try {
  const deadline = Date.now() + 60_000;
  let info;
  while (!info) {
    const failed = child.exitCode !== null || Date.now() > deadline;
    if (failed) throw new Error(`Host startup failed: ${stderr}`);
    const ready = stdout.split('\n').find(line => line.startsWith('{'));
    if (ready) info = JSON.parse(ready);
    else await delay(100);
  }
  await setPhase('host-baseline');
  await delay(2000);
  browser = await chromium.launch({ headless: true });
  for (let client = 0; client < 4; client++) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(info.url);
    await page.locator('#status').filter({ hasText: 'Ready' }).waitFor();
  }
  await pages[0].evaluate(async documentCount => {
    const sdk = await import('firebase/firestore');
    const db = sdk.getFirestore();
    for (let start = 0; start < documentCount; start += 100) {
      const batch = sdk.writeBatch(db);
      for (let index = start; index < Math.min(start + 100, documentCount); index++) {
        const value = { index, sequence: -1, padding: '' };
        value.padding = 'x'.repeat(1024 - JSON.stringify(value).length);
        batch.set(sdk.doc(db, 'acceptance', String(index)), value);
      }
      await batch.commit();
    }
  }, documentCount);
  for (const page of pages) {
    await page.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      const db = sdk.getFirestore();
      const state = globalThis.__acceptance = { deliveries: 0, errors: [], latest: {}, stops: [], windows: [] };
      await Promise.all(Array.from({ length: 20 }, (_, index) => new Promise((resolve, reject) => {
        const id = String(index * 50);
        state.stops.push(sdk.onSnapshot(sdk.doc(db, 'acceptance', id), snapshot => {
          state.deliveries++;
          state.latest[id] = snapshot.data();
          resolve();
        }, error => { state.errors.push(String(error)); reject(error); }));
      })));
    });
  }
  await delay(1000);
  await setPhase('attached-baseline');
  await delay(1000);
  stalled = new WebSocket(`${info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
  const ready = Promise.withResolvers();
  stalled.on('error', () => {});
  stalled.once('close', (code, reason) => { stalledClose = { code, reason: reason.toString() }; });
  stalled.once('open', () => stalled.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' })));
  stalled.on('message', data => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'attach-ack') stalled.send(JSON.stringify({ type: 'worker-message', message: { t: 'sub', subId: 'stalled', target: 'events' } }));
    if (frame.type === 'worker-message-result' && frame.message.t === 'event') ready.resolve();
  });
  await Promise.race([ready.promise, delay(10_000).then(() => { throw new Error('Stalled observer did not attach'); })]);
  stalled.pause();
  for (const [name, milliseconds] of [['warmup', warmupMs], ['measurement', durationMs]]) {
    await setPhase(name);
    result[`${name}StartedAt`] = Date.now();
    const measurements = await Promise.all(pages.map((page, client) => page.evaluate(runBrowserWorkload,
      { milliseconds, client, name, ratePerClient: rate / 4 })));
    windows.push(...measurements);
    result[`${name}EndedAt`] = Date.now();
    const incomplete = measurements.find(client => client.drainError);
    if (incomplete) throw new Error(incomplete.drainError);
    save();
  }
  await setPhase('drain');
  stalled.resume();
  await delay(5000);
  result.stalledClose = stalledClose ?? null;
  result.clientsFinal = await Promise.all(pages.map(page => page.evaluate(async () => {
    const sdk = await import('firebase/firestore');
    const state = globalThis.__acceptance;
    const mismatches = [];
    for (const [id, observed] of Object.entries(state.latest)) {
      const current = await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'acceptance', id));
      if (JSON.stringify(current.data()) !== JSON.stringify(observed)) mismatches.push(id);
    }
    state.stops.forEach(stop => stop());
    return { deliveries: state.deliveries, errors: state.errors, mismatches };
  })));
  result.finalDocuments = await pages[0].evaluate(async () => {
    const sdk = await import('firebase/firestore');
    return (await sdk.getDocs(sdk.collection(sdk.getFirestore(), 'acceptance'))).size;
  });
  await setPhase('history-count');
  result.historyCountBoundary = await verifyHistoryCountBoundary(pages[0], WebSocket, info.url);
  await setPhase('unsubscribed');
  await delay(3000);
  for (const context of contexts) await context.close();
  await setPhase('disposed');
  await delay(65_000); // Declared interrupted-session retention is 60 seconds.
  result.diskBytes = diskBytes();
} catch (error) {
  errors.push(String(error));
  result.failure = String(error);
} finally {
  clearInterval(progress);
  stalled?.terminate();
  await browser?.close();
  const running = child.exitCode === null && child.signalCode === null;
  if (running) child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  result.hostExitCode = await exited;
  clearTimeout(kill);
  clearTimeout(watchdog);
  result.stderrTail = stderr.slice(-4000);
  result.safetyAbort = safetyAbort ?? null;
  rmSync(project, { recursive: true, force: true });
  result.cleanedUp = true;
  const measured = windows.filter(window => window.phase === 'measurement');
  const intervalResults = measured.flatMap(client => client.windows);
  const measuredSamples = samples.filter(sample => sample.phase === 'measurement');
  const histories = measuredSamples.flatMap(sample => sample.histories);
  const scheduled = measured.reduce((sum, client) => sum + client.scheduled, 0);
  const completed = intervalResults.reduce((sum, window) => sum + window.completed, 0);
  const serviceErrors = intervalResults.reduce((sum, window) => sum + window.errors, 0);
  const skippedAtPendingLimit = measured.reduce((sum, client) => sum + client.skippedAtPendingLimit, 0);
  const workloadSummary = summarizeBrowserWorkloads(measured);
  result.phases = {
    warmup: summarizeBrowserWorkloads(windows.filter(client => client.phase === 'warmup')),
    measurement: workloadSummary,
  };
  result.summary = workloadSummary === null ? null : { ...workloadSummary,
    worstWindowP95Ms: Math.max(...intervalResults.map(window => window.p95Ms)),
    worstWindowP99Ms: Math.max(...intervalResults.map(window => window.p99Ms)),
    maxHostRssBytes: Math.max(...samples.map(sample => sample.memory.rss)),
    maxCaptureDelayMs: Math.max(...samples.map(sample => sample.capture.maxDelayMs)),
    maxHistoryEntries: Math.max(...histories.map(history => history.entries)),
    maxHistoryBytes: Math.max(...histories.map(history => history.bytes)),
    maxSocketBacklogBytes: Math.max(...samples.map(sample => sample.socketBytes)) };
  result.checks = {
    fullDuration: !diagnostic && !smoke && measured.length === 4 && measuredSamples.length > 0,
    allWorkCompleted: scheduled === Math.round(durationMs / 1000 * rate / 4) * 4 && completed === scheduled && serviceErrors === 0 && skippedAtPendingLimit === 0,
    accounting: measured.length === 4 && measured.every(client => client.accountingValid),
    latency: intervalResults.length > 0 && intervalResults.every(window => {
      const hasSamples = window.p95Ms !== null && window.p99Ms !== null;
      return hasSamples && window.p95Ms < 500 && window.p99Ms < 2000;
    }),
    captureDeadline: measuredSamples.length > 0 && measuredSamples.every(sample => sample.capture.maxDelayMs <= 2000),
    observationRetention: histories.length > 0 && histories.every(history => history.entries + history.liveCount <= 10000 && history.bytes <= 8 * 1024 * 1024),
    historyCountLimitReached: result.historyCountBoundary?.passed === true,
    journalHealthy: measuredSamples.length > 0 && measuredSamples.every(sample => sample.history.healthy && sample.history.unrecorded === 0),
    operationBounds: samples.every(sample => sample.maxPendingCount <= 256 && sample.maxPendingBytes <= 24 * 1024 * 1024),
    stalledObserverRefused: result.stalledRefusal !== undefined && stalledClose?.code === 1013
      && stalledClose.reason === 'Client output backlog exceeds 24 MiB; reconnect to resume.',
    fixedDataset: result.finalDocuments === documentCount,
    listenerDelivery: result.clientsFinal?.every(client => client.deliveries > 20 && client.errors.length === 0 && client.mismatches.length === 0) ?? false,
    releasedSubscriptions: samples.at(-1)?.subscriptions === 0,
    noRuntimeErrors: errors.length === 0,
  };
  result.accepted = Object.values(result.checks).every(Boolean);
  result.diagnosticCompleted = diagnostic && !result.failure && !safetyAbort && result.hostExitCode === 0
    && result.checks.accounting && result.checks.fixedDataset && result.checks.noRuntimeErrors
    && result.checks.releasedSubscriptions;
  result.verdict = diagnostic ? 'Diagnostic run only; not milestone acceptance evidence.' : 'Acceptance run';
  if (detailed) result.cpuProfile = existsSync(profilePath) ? profilePath : null;
  save();
  console.log(JSON.stringify({ finished: true, output, failure: result.failure, checks: result.checks, phases: result.phases, summary: result.summary, cleanedUp: true }));
}
const completedSuccessfully = diagnostic ? result.diagnosticCompleted : result.accepted;
if (!completedSuccessfully) process.exitCode = 1;
