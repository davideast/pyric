/**
 * #1162: a discovery health probe against a port whose connect never
 * completes must give up at its deadline and leave nothing behind that holds
 * the process open. Under WSL mirrored networking a closed loopback port
 * drops SYNs instead of refusing, and an aborted `fetch` left undici's connect
 * pending for its own 10 s timeout, so every registered Node process sat
 * about 10 s past its work.
 *
 * The probe runs in a real Node child (the runtime the bug lives in; Bun's
 * fetch does not keep the connect) from the built `dist/`, so this needs
 * `bun run build` first.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blackholedPort } from '../blackholed-port.js';

const discoveryUrl = pathToFileURL(join(resolve(import.meta.dir, '../..'), 'dist/serve/discovery.js')).href;

interface ProbeRun {
  readonly health: unknown;
  readonly probeMs: number;
  /** Wall clock (epoch ms) when the probe settled in the child. */
  readonly probeEndedAt: number;
  readonly resources: string[];
  readonly exitMs: number;
  /** Wall clock (epoch ms) when the parent saw the child exit. */
  readonly exitedAt: number;
}

/** What a settled probe might leave holding the loop: its socket, its connect, its deadline. */
const PROBE_RESOURCES = new Set(['ConnectWrap', 'TCPSocketWrap', 'Timeout']);

function probeInNode(base: string): Promise<ProbeRun> {
  const script = `const { probeHealth } = await import(${JSON.stringify(discoveryUrl)});
const started = performance.now();
const health = await probeHealth(${JSON.stringify(base)});
const probeMs = performance.now() - started;
const probeEndedAt = Date.now();
// A destroyed socket's handle closes in the loop's close phase; sample after it.
await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
const resources = process.getActiveResourcesInfo();
process.stdout.write(JSON.stringify({ health, probeMs, probeEndedAt, resources }));`;
  const started = performance.now();
  const child = spawn('node', ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      const exitMs = performance.now() - started;
      const exitedAt = Date.now();
      try {
        resolvePromise({ ...(JSON.parse(stdout) as Omit<ProbeRun, 'exitMs' | 'exitedAt'>), exitMs, exitedAt });
      } catch {
        reject(new Error(`the probe child printed no result: ${JSON.stringify(stdout)}`));
      }
    });
  });
}

describe('discovery health probe deadline', () => {
  it('gives up on a connect that never completes and lets the process exit', async () => {
    const hole = await blackholedPort();
    try {
      const run = await probeInNode(`http://127.0.0.1:${hole.port}`);
      expect(run.health).toBeNull();
      expect(run.probeMs).toBeLessThan(1_500);
      expect(run.resources.filter((name) => PROBE_RESOURCES.has(name))).toEqual([]);
      expect(run.exitMs).toBeLessThan(4_000);
    } finally {
      hole.close();
    }
  }, 30_000);

  it('returns a healthy host and leaves no socket or deadline timer behind', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"sandbox","instanceId":"healthy-host"}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const run = await probeInNode(`http://127.0.0.1:${port}`);
      expect(run.health).toEqual({ mode: 'sandbox', instanceId: 'healthy-host' });
      expect(run.resources.filter((name) => PROBE_RESOURCES.has(name))).toEqual([]);
      expect(run.exitedAt - run.probeEndedAt).toBeLessThan(500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);
});
