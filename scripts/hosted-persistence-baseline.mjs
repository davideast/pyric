/** Bounded real-browser workload. Run with the supported Node executable. */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const durationMs = Number(process.env.PYRIC_BASELINE_DURATION_MS ?? 60_000);
const runs = Number(process.env.PYRIC_BASELINE_RUNS ?? 3);
const writesPerSecond = Number(process.env.PYRIC_BASELINE_RATE ?? 200);
const node = process.execPath;
const results = [];
const environment = { node: process.version, cpu: cpus()[0].model, memoryBytes: totalmem(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
console.log(JSON.stringify({ environment, durationMs, runs, writesPerSecond, documents: 100, paddingBytes: 256, maximumPending: 64 }));
const browser = await chromium.launch({ headless: true });
try {
  for (let run = 1; run <= runs; run++) {
    const project = mkdtempSync(join(tmpdir(), 'pyric-browser-persistence-'));
    for (const name of ['index.html', 'main.js']) {
      writeFileSync(join(project, name), readFileSync(join(root, 'packages/cli/test/e2e/hosted/fixture', name)));
    }
    const child = spawn(node, [join(root, 'packages/cli/dist/cli/index.js'), 'sandbox', '--hosted', '--bridge', '--no-open', '--port', '0', '--json', '--no-cache', '--no-capture'], {
      cwd: project,
      env: { ...process.env, CI: '1', NODE_OPTIONS: `--import=${join(root, 'scripts/hosted-persistence-baseline-host.mjs')}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', resolve));
    const deadline = setTimeout(() => child.kill('SIGKILL'), durationMs + 100_000);
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
      const startedAt = Date.now();
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
        let timeout;
        try {
          await Promise.race([Promise.all(pending), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Drain exceeded 10 seconds')), 10_000); })]);
        } finally { clearTimeout(timeout); }
        times.sort((a, b) => a - b);
        return { offered, completed: times.length, errors: errors.length, firstError: errors[0], rejectedByHarness, peakPending, elapsedMs: performance.now() - start, ackP95Ms: times[Math.ceil(times.length * .95) - 1], ackMaxMs: times.at(-1) };
      }, { duration: durationMs, rate: writesPerSecond });
      const samples = stdout.split('\n').filter(line => line.startsWith('PYRIC_PERSISTENCE_METRICS ')).map(line => JSON.parse(line.slice('PYRIC_PERSISTENCE_METRICS '.length))).filter(sample => sample.at >= startedAt + 10_000);
      const result = { run, ...measurements, hostSamples: samples };
      results.push(result);
      console.log(JSON.stringify(result));
      if (process.env.PYRIC_BASELINE_OUTPUT) writeFileSync(process.env.PYRIC_BASELINE_OUTPUT, JSON.stringify({ environment, durationMs, writesPerSecond, results }, null, 2));
      const failedWorkload = measurements.errors > 0 || measurements.rejectedByHarness > 0;
      if (failedWorkload) throw new Error('Workload failed; do not treat reduced completed work as a latency pass');
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
const output = process.env.PYRIC_BASELINE_OUTPUT;
if (output) writeFileSync(output, JSON.stringify({ environment, durationMs, results }, null, 2));
