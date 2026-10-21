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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blackholedPort } from '../blackholed-port.js';

const discoveryUrl = pathToFileURL(join(resolve(import.meta.dir, '../..'), 'dist/serve/discovery.js')).href;

interface ProbeRun {
  readonly health: unknown;
  readonly probeMs: number;
  readonly resources: string[];
  readonly exitMs: number;
}

function probeInNode(base: string): Promise<ProbeRun> {
  const script = `const { probeHealth } = await import(${JSON.stringify(discoveryUrl)});
const started = performance.now();
const health = await probeHealth(${JSON.stringify(base)});
const probeMs = performance.now() - started;
// A destroyed socket's handle closes in the loop's close phase; sample after it.
await new Promise((resolve) => setTimeout(resolve, 20));
process.stdout.write(JSON.stringify({ health, probeMs, resources: process.getActiveResourcesInfo() }));`;
  const started = performance.now();
  const child = spawn('node', ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      const exitMs = performance.now() - started;
      resolvePromise({ ...(JSON.parse(stdout) as Omit<ProbeRun, 'exitMs'>), exitMs });
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
      const socketResources = run.resources.filter((name) => name === 'ConnectWrap' || name === 'TCPSocketWrap');
      expect(socketResources).toEqual([]);
      expect(run.exitMs).toBeLessThan(4_000);
    } finally {
      hole.close();
    }
  }, 30_000);
});
