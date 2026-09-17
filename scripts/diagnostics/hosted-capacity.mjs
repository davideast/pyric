/** Diagnostic load/drain/idle profile, not a replacement for the frozen acceptance gate. */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const durationMs = Number(process.env.PYRIC_BASELINE_DURATION_MS ?? 30_000);
const runs = 1;
const writesPerSecond = Number(process.env.PYRIC_BASELINE_RATE ?? 200);
const chipDisabled = process.env.PYRIC_CAPACITY_CHIP === 'off';
const node = process.execPath;
const results = [];
const environment = { node: process.version, cpu: cpus()[0].model, memoryBytes: totalmem(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
console.log(JSON.stringify({ environment, durationMs, runs, writesPerSecond, chipDisabled, documents: 100, paddingBytes: 256, maximumPending: 64 }));
const browser = await chromium.launch({ headless: true });
try {
  for (let run = 1; run <= runs; run++) {
    const project = mkdtempSync(join(tmpdir(), 'pyric-browser-persistence-'));
    for (const name of ['index.html', 'main.js']) {
      writeFileSync(join(project, name), readFileSync(join(root, 'packages/cli/test/e2e/hosted/fixture', name)));
    }
    if (chipDisabled) {
      const html = join(project, 'index.html');
      writeFileSync(html, readFileSync(html, 'utf8').replace('<html lang="en">', '<html lang="en"><meta name="pyric-runtime-chip" content="off">'));
    }
    const child = spawn(node, ['--expose-gc', join(root, 'packages/cli/dist/cli/index.js'), 'sandbox', '--hosted', '--bridge', '--no-open', '--port', '0', '--json', '--no-cache', '--no-capture'], {
      cwd: project,
      env: { ...process.env, CI: '1', NODE_OPTIONS: `--import=${join(root, 'scripts/diagnostics/capacity-host.mjs')}` },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const hostSamples = [];
    const replies = new Map();
    let nextCommand = 0;
    child.on('message', message => {
      if (message.type === 'sample') hostSamples.push(message);
      if (message.type === 'reply') replies.get(message.id)?.(message);
    });
    async function control(command, extra = {}) {
      const id = ++nextCommand;
      const reply = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { replies.delete(id); reject(new Error('Diagnostic command timed out')); }, 10_000);
        replies.set(id, message => { clearTimeout(timeout); replies.delete(id); message.error ? reject(new Error(message.error)) : resolve(); });
      });
      child.send({ id, command, ...extra });
      return reply;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', resolve));
    const deadline = setTimeout(() => child.kill('SIGKILL'), durationMs * 2 + 100_000);
    const context = await browser.newContext();
    try {
      const startupDeadline = Date.now() + 60_000;
      let info;
      while (!info) {
        const failed = child.exitCode !== null || Date.now() > startupDeadline;
        if (failed) throw new Error(`Host startup failed: ${stderr.slice(-3000)}`);
        const readyLine = stdout.split('\n').find(line => line.startsWith('{'));
        if (readyLine) info = JSON.parse(readyLine);
        else await delay(100);
      }
      const page = await context.newPage();
      await page.goto(info.url);
      await page.locator('#write:not([disabled])').waitFor();
      const chipCount = await page.locator('[data-pyric-runtime-chip-host]').count();
      if (chipCount !== (chipDisabled ? 0 : 1)) throw new Error(`Unexpected runtime chip count: ${chipCount}`);
      await delay(3000);
      await control('gc', { phase: 'baseline-after-gc' });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      const cycles = [];
      for (let cycle = 1; cycle <= 2; cycle++) {
        await control('phase', { phase: `load-${cycle}` });
        const measurements = await page.evaluate(async ({ duration, rate }) => {
          const sdk = await import('firebase/firestore');
          const db = sdk.getFirestore();
          const padding = 'x'.repeat(256);
          const pending = new Set();
          const times = [];
          const errors = [];
          let offered = 0;
          let rejectedByHarness = 0;
          let peakPending = 0;
          const start = performance.now();
          const interval = 1000 / rate;
          while (performance.now() - start < duration) {
            const due = Math.min(Math.floor((performance.now() - start) / interval) + 1, duration / interval);
            while (offered < due) {
              const index = offered++;
              if (pending.size >= 64) { rejectedByHarness++; continue; }
              const sent = performance.now();
              const operation = sdk.setDoc(sdk.doc(db, `baseline/doc-${index % 100}`), { index, padding })
                .then(() => { times.push(performance.now() - sent); })
                .catch(error => { errors.push(String(error)); })
                .finally(() => { pending.delete(operation); });
              pending.add(operation);
              peakPending = Math.max(peakPending, pending.size);
            }
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          const loadEnd = performance.now();
          let timeout;
          try {
            await Promise.race([Promise.all(pending), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Drain exceeded 10 seconds')), 10_000); })]);
          } finally { clearTimeout(timeout); }
          times.sort((a, b) => a - b);
          return { offered, completed: times.length, errors: errors.length, firstError: errors[0], rejectedByHarness, peakPending, elapsedMs: performance.now() - start, drainMs: performance.now() - loadEnd, ackP95Ms: times[Math.ceil(times.length * .95) - 1], ackMaxMs: times.at(-1) };
        }, { duration: durationMs, rate: writesPerSecond });
        cycles.push(measurements);
        console.log(JSON.stringify({ cycle, ...measurements }));
        await control('phase', { phase: `drained-${cycle}` });
        await delay(5000);
        await control('phase', { phase: `idle-${cycle}` });
        await control('gc', { phase: `after-gc-${cycle}` });
        await delay(1000);
      }
      const output = process.env.PYRIC_BASELINE_OUTPUT ?? '/tmp/pyric-capacity-profile.json';
      await control('profile', { path: `${output}.host.cpuprofile` });
      const { profile } = await cdp.send('Profiler.stop');
      const scriptUrls = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(url => url.includes('/__pyric/sdk/') && url.endsWith('.js')));
      const browserScripts = {};
      for (const url of scriptUrls) browserScripts[url] = await (await context.request.get(url)).text();
      writeFileSync(`${output}.browser-scripts.json`, JSON.stringify(browserScripts));
      // Destructive attribution only after the workload, in the disposable host.
      for (const kind of ['undo', 'observations']) {
        await control('clear-owner', { kind });
        await delay(100);
        await control('gc', { phase: `without-${kind}` });
      }
      writeFileSync(`${output}.browser.cpuprofile`, JSON.stringify(profile));
      const result = { run, cycles, hostSamples };
      results.push(result);
      writeFileSync(output, JSON.stringify({ environment, durationMs, writesPerSecond, chipDisabled, results }, null, 2));
      console.log(`Profile saved: ${output}`);
    } finally {
      await context.close();
      const running = child.exitCode === null && child.signalCode === null;
      if (running) child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(kill);
      clearTimeout(deadline);
      rmSync(project, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
