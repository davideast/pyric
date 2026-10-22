/**
 * The root cause of the orphaned, spinning Functions children: a send on a
 * closed channel, with an uncaughtException handler that reports by sending.
 * This runs that exact shape in a real Node child against the built
 * `child-ipc.js`. With a bare `process.send(message)`, the child never prints:
 * its next-tick loop starves the timer below, and the test times out.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const builtIpc = resolve(import.meta.dir, '../../dist/functions/child-ipc.js');

const CHILD = (ipcUrl: string) => `
import { sendToHost, disconnectFromHost } from ${JSON.stringify(ipcUrl)};
let uncaught = 0;
process.on('uncaughtException', (error) => {
  uncaught += 1;
  sendToHost({ type: 'uncaught-error', message: String(error) });
});
process.once('disconnect', () => {
  // The host is gone. A trigger that finishes now still sends its result.
  sendToHost({ type: 'execution' });
  disconnectFromHost();
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ uncaught }));
    process.exit(0);
  }, 300);
});
process.send({ type: 'ready' });
`;

const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

describe('sendToHost on a closed channel', () => {
  test('emits no error and leaves the event loop free, even with an uncaughtException reporter', async () => {
    if (!existsSync(builtIpc)) throw new Error(`build the CLI first: ${builtIpc}`);
    const dir = mkdtempSync(join(tmpdir(), 'pyric-child-ipc-'));
    const script = join(dir, 'child.mjs');
    writeFileSync(script, CHILD(pathToFileURL(builtIpc).href));
    const child = spawn('node', [script], { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
    started.push(child);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    await new Promise<void>((resolveReady) => child.once('message', () => resolveReady()));
    child.disconnect();
    const code = await Promise.race([
      new Promise<number | null>((resolveExit) => child.once('exit', (exitCode) => resolveExit(exitCode))),
      Bun.sleep(3_000).then(() => 'timed out' as const),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ uncaught: 0 });
  }, 10_000);
});
