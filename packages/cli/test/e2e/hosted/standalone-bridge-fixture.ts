import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';

/** The bridge CLI requires a nonzero port, so release a temporary listener first. */
export async function startStandaloneBridge() {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => reservation.close(error => {
    const hasError = error !== undefined;
    if (hasError) reject(error);
    else resolve();
  }));
  const hasNoPort = address === null || typeof address === 'string';
  if (hasNoPort) throw new Error('Bridge fixture did not reserve a port');
  const port = address.port;
  const child = spawn(process.execPath, [CLI_PATH, 'bridge', '--port', String(port), '--project', `frame-limit-${randomUUID()}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = Promise.withResolvers<number | null>();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.once('error', error => { output += error.message; exited.resolve(null); });
  child.once('exit', exited.resolve);
  const stop = async () => {
    const isRunning = child.exitCode === null && child.signalCode === null;
    if (isRunning) child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      return await exited.promise;
    } finally {
      clearTimeout(deadline);
    }
  };
  try {
    await expect.poll(() => output.includes(`sandbox: ws://127.0.0.1:${port}/sandbox`), { timeout: 10_000 }).toBe(true);
    return { url: `http://127.0.0.1:${port}`, output: () => output, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
