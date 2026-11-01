/**
 * #1167: CLI commands that probe a local port must give up at their deadline
 * and let the process exit, even where the port's connect never completes.
 * Under WSL mirrored networking a closed loopback port drops SYNs instead of
 * refusing, and an aborted `fetch` leaves undici's connect pending for its own
 * 10 s timeout, which holds the process open past the command's answer.
 *
 * Each command runs in a real Node child (the runtime the bug lives in; Bun's
 * fetch does not keep the connect) from the built `dist/`, so this needs
 * `bun run build` first.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blackholedPort } from '../blackholed-port.js';

const dist = (path: string): string => pathToFileURL(join(resolve(import.meta.dir, '../..'), 'dist', path)).href;

interface CommandRun {
  readonly result: unknown;
  /** Whether a command run through `beforeSentinel` settled before its sentinel timer fired. */
  readonly beatSentinel?: boolean;
  /** Milliseconds from the command settling until the parent saw the child exit. */
  readonly lingerMs: number;
}

/**
 * Run `body` (module source whose last statement assigns `result`) in a Node
 * child, timing the exit after it.
 *
 * `body` may wrap its command in `beforeSentinel(sentinelMs, () => command)`,
 * which arms a sentinel timer in the same turn as the call. The command beats
 * the sentinel only if its own deadline timers end it first. Timers fire in
 * the order they fall due, so a child the machine stalls or starves (#1705)
 * runs late on both and keeps that order, where a wall-clock bound fails.
 */
function runInNode(body: string): Promise<CommandRun> {
  const script = `let result;
let beatSentinel;
const beforeSentinel = async (sentinelMs, run) => {
  let fired = false;
  const sentinel = setTimeout(() => { fired = true; }, sentinelMs);
  try {
    return await run();
  } finally {
    beatSentinel = !fired;
    clearTimeout(sentinel);
  }
};
${body}
process.stdout.write(JSON.stringify({ result, beatSentinel, endedAt: Date.now() }));`;
  const child = spawn('node', ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.resume();
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      const exitedAt = Date.now();
      try {
        const printed = JSON.parse(stdout) as { result: unknown; beatSentinel?: boolean; endedAt: number };
        resolvePromise({ result: printed.result, beatSentinel: printed.beatSentinel, lingerMs: exitedAt - printed.endedAt });
      } catch {
        reject(new Error(`the command child printed no result: ${JSON.stringify(stdout)}`));
      }
    });
  });
}

/** Bound on the time between a command settling and its process exiting. */
const PROMPT_EXIT_MS = 1_500;

const pyricBin = join(resolve(import.meta.dir, '../..'), 'dist/cli/index.js');

/** Run the built `pyric` command in `cwd`, for its exit code and wall time. */
function runPyric(args: string[], cwd: string): Promise<{ code: number | null; wallMs: number }> {
  const started = performance.now();
  const child = spawn('node', [pyricBin, ...args], { cwd, stdio: 'ignore' });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code, wallMs: performance.now() - started }));
  });
}

describe('the pyric command against a port whose connect never completes', () => {
  it('pyric snapshot --port exits about its two 750 ms probes after start', async () => {
    const hole = await blackholedPort();
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-snapshot-bin-blackhole-'));
    try {
      const run = await runPyric(['snapshot', '--port', String(hole.port)], cwd);
      expect(run.code).toBe(2);
      expect(run.wallMs).toBeLessThan(5_000);
    } finally {
      hole.close();
    }
  }, 30_000);

  it('pyric serve diagnostics --url exits about its 3 s deadline after start', async () => {
    const hole = await blackholedPort();
    try {
      const run = await runPyric(['serve', 'diagnostics', '--url', `http://127.0.0.1:${hole.port}`], tmpdir());
      expect(run.code).toBe(2);
      expect(run.wallMs).toBeLessThan(6_500);
    } finally {
      hole.close();
    }
  }, 30_000);
});

describe('the dev server collision probe', () => {
  it('ends its real request when the attachment closes, leaving no socket open', async () => {
    const run = await runInNode(`const { createBridgeMount } = await import(${JSON.stringify(dist('serve/bridge-mount.js'))});
const { createServer } = await import('node:http');
const { EventEmitter } = await import('node:events');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const rejections = [];
process.on('unhandledRejection', (reason) => { rejections.push(String(reason)); });
// Accepts the probe's connect and never answers it.
const silent = createServer(() => {});
await new Promise((done) => silent.listen(0, '127.0.0.1', done));
const port = silent.address().port;
const host = Object.assign(new EventEmitter(), { listening: true, address: () => ({ port }) });
const mount = createBridgeMount({ disableAuditLog: true });
const attachment = mount.attachHost({
  servers: [host],
  projectDir: mkdtempSync(join(tmpdir(), 'pyric-collision-probe-close-')),
  origin: () => ({ host: '127.0.0.1', port }),
  collision: { warn() {} },
});
await new Promise((done) => setTimeout(done, 100));
const accepted = await new Promise((done) => silent.getConnections((_error, count) => done(count)));
const closeStarted = performance.now();
await attachment.close();
const closeMs = performance.now() - closeStarted;
// A destroyed socket's close reaches the server a turn or two later.
await new Promise((done) => setTimeout(done, 50));
const openSockets = await new Promise((done) => silent.getConnections((_error, count) => done(count)));
await mount.close();
silent.close();
result = { accepted, closeMs, openSockets, rejections };`);
    const outcome = run.result as { accepted: number; closeMs: number; openSockets: number; rejections: string[] };
    expect(outcome.accepted).toBe(1);
    expect(outcome.closeMs).toBeLessThan(200);
    expect(outcome.openSockets).toBe(0);
    expect(outcome.rejections).toEqual([]);
    expect(run.lingerMs).toBeLessThan(PROMPT_EXIT_MS);
  }, 30_000);
});

describe('local probe deadlines', () => {
  it('pyric snapshot gives up on a live port whose connect never completes, then exits', async () => {
    const hole = await blackholedPort();
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-snapshot-blackhole-'));
    try {
      const run = await runInNode(`const { runSnapshot } = await import(${JSON.stringify(dist('cli/snapshot.js'))});
const { parseArgs } = await import(${JSON.stringify(dist('cli/parse-args.js'))});
const sink = { write() {} };
result = await beforeSentinel(3000, () => runSnapshot(parseArgs(['snapshot', '--port', '${hole.port}']), { cwd: ${JSON.stringify(cwd)}, stdout: sink, stderr: sink }));`);
      expect(run.result).toBe(2);
      // Two 750 ms probes, init.json then state, end before a timer for twice their sum.
      expect(run.beatSentinel).toBe(true);
      expect(run.lingerMs).toBeLessThan(PROMPT_EXIT_MS);
    } finally {
      hole.close();
    }
  }, 30_000);

  it('pyric serve diagnostics reports an unreachable server at its deadline, then exits', async () => {
    const hole = await blackholedPort();
    try {
      const run = await runInNode(`const { runServeDiagnostics } = await import(${JSON.stringify(dist('cli/serve-diagnostics.js'))});
const { parseArgs } = await import(${JSON.stringify(dist('cli/parse-args.js'))});
let output = '';
const code = await beforeSentinel(6000, () => runServeDiagnostics(parseArgs(['serve', 'diagnostics', '--url', 'http://127.0.0.1:${hole.port}']), { stdout: { write(value) { output += value; } } }));
result = { code, report: JSON.parse(output) };`);
      expect(run.result).toMatchObject({ code: 2, report: { server: { http: 'unreachable' } } });
      // The 3 s deadline ends the request before a timer for twice it.
      expect(run.beatSentinel).toBe(true);
      expect(run.lingerMs).toBeLessThan(PROMPT_EXIT_MS);
    } finally {
      hole.close();
    }
  }, 30_000);

  it('the sandbox peer wait ends at its timeout on a health port whose connect never completes, then exits', async () => {
    const hole = await blackholedPort();
    try {
      const run = await runInNode(`const { waitForSandboxPeer } = await import(${JSON.stringify(dist('cli/sandbox-runner.js'))});
result = await beforeSentinel(2000, () => waitForSandboxPeer('http://127.0.0.1:${hole.port}', { timeoutMs: 1000, intervalMs: 100 }));`);
      expect(run.result).toBe(false);
      // The 1 s timeout ends the wait before a timer for twice it.
      expect(run.beatSentinel).toBe(true);
      expect(run.lingerMs).toBeLessThan(PROMPT_EXIT_MS);
    } finally {
      hole.close();
    }
  }, 30_000);
});
