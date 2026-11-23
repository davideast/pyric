// Aborting SingleRequestOptions.signal mid-stream cancels the page stream and
// disconnects the upstream generator across SharedWorker, Node host, and
// in-page sandbox planes (#1633). Also covers aborting before the upstream
// sends response headers (relying on #1634 proxy disconnect handling).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { scenario, type App, type DevServer } from '../driver.ts';
import { standInNodeCommand } from './stand-in-runtime.ts';

declare function abortAfterChunks(
  tag: string,
  stopAfter: number,
): Promise<{
  seen: string[];
  streamError: { name: string | null; message: string } | null;
  responseError: { name: string | null; message: string } | null;
}>;

declare function startSlowHeaders(tag: string): void;

declare function abortSlowHeaders(tag: string): Promise<{
  chunks: number;
  error: { name: string | null; message: string } | null;
}>;

const TOTAL_CHUNKS = 40;
const STAND_IN_KEY = 'scenario-abort-key-1633';

interface StreamRecord {
  kind: 'stream' | 'slow-headers';
  chunksWritten: number;
  headersSent: boolean;
  disconnected: boolean;
  done: boolean;
}

async function startNodeStandIn(app: App): Promise<{ url: string; child: ChildProcess }> {
  const scriptPath = join(app.dir, 'stand-in.mjs');
  const child = spawn(standInNodeCommand(), [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`stand-in failed to listen: ${stderr || stdout}`));
    }, 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = stdout.match(/^STAND_IN_READY (http:\/\/127\.0\.0\.1:\d+)$/m);
      if (match && match[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`stand-in exited early (${String(code)}): ${stderr || stdout}`));
    });
  });
  return { url, child };
}

async function fetchRecords(standInUrl: string): Promise<StreamRecord[]> {
  const response = await fetch(`${standInUrl}/_records`);
  return (await response.json()) as StreamRecord[];
}

async function waitForRecordArrival(
  standInUrl: string,
  index: number,
  label: string,
  timeoutMs = 10_000,
): Promise<StreamRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: StreamRecord[] = [];
  for (;;) {
    last = await fetchRecords(standInUrl);
    const rec = last[index];
    if (rec !== undefined) {
      return rec;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label} (records=${JSON.stringify(last.slice(index))})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function waitForRecord(
  standInUrl: string,
  index: number,
  label: string,
  timeoutMs = 10_000,
): Promise<StreamRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: StreamRecord[] = [];
  for (;;) {
    last = await fetchRecords(standInUrl);
    const rec = last[index];
    if (rec !== undefined && rec.disconnected) {
      return rec;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label} (records=${JSON.stringify(last.slice(index))})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function verifyPlane(
  app: App,
  host: DevServer,
  standInUrl: string,
  plane: string,
): Promise<void> {
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'abortAfterChunks' in window);

  const beforeMid = (await fetchRecords(standInUrl)).length;
  const outputBefore = host.process.output.length;
  const mid = await page.evaluate(
    (tag: string) => abortAfterChunks(tag, 3),
    `${plane}-mid`,
  );
  assert.deepEqual(mid.seen, ['c0 ', 'c1 ', 'c2 '], `${plane}: saw wrong chunks: ${JSON.stringify(mid)}`);
  assert.equal(mid.streamError?.name, 'AbortError', `${plane}: stream error: ${JSON.stringify(mid)}`);
  assert.equal(mid.responseError?.name, 'AbortError', `${plane}: response error: ${JSON.stringify(mid)}`);
  const midRecord = await waitForRecord(
    standInUrl,
    beforeMid,
    `${plane} upstream disconnect on mid-stream abort`,
  );
  assert.equal(midRecord.disconnected, true, `${plane}: upstream never saw disconnect`);
  assert.ok(
    midRecord.chunksWritten < 15,
    `${plane}: expected upstream to stop early, wrote ${midRecord.chunksWritten}/${TOTAL_CHUNKS}`,
  );

  const beforeEarly = (await fetchRecords(standInUrl)).length;
  const earlyTag = `${plane}-early`;
  await page.evaluate((tag: string) => startSlowHeaders(tag), earlyTag);
  await waitForRecordArrival(
    standInUrl,
    beforeEarly,
    `${plane} upstream request arrival before headers`,
  );
  const early = await page.evaluate(
    (tag: string) => abortSlowHeaders(tag),
    earlyTag,
  );
  assert.equal(early.chunks, 0, `${plane}: expected 0 chunks before headers`);
  assert.equal(early.error?.name, 'AbortError', `${plane}: early abort error: ${JSON.stringify(early)}`);
  const earlyRecord = await waitForRecord(
    standInUrl,
    beforeEarly,
    `${plane} upstream disconnect before headers`,
  );
  assert.equal(earlyRecord.headersSent, false, `${plane}: headers should not have been sent`);
  assert.equal(earlyRecord.chunksWritten, 0, `${plane}: expected 0 chunks written`);

  const terminalDelta = host.process.output.slice(outputBefore);
  assert.doesNotMatch(terminalDelta, /upstream unreachable/i, `${plane}: unexpected proxy error log:\n${terminalDelta}`);
  assert.doesNotMatch(terminalDelta, /\[500 INTERNAL\]/i, `${plane}: unexpected 500 rejection log:\n${terminalDelta}`);
}

export default scenario(async (app) => {
  const standIn = await app.step('start the streaming Gemini stand-in server (Node)', () =>
    startNodeStandIn(app),
  );
  const baseEnv = {
    GEMINI_API_KEY: STAND_IN_KEY,
    GEMINI_STAND_IN_URL: standIn.url,
  };

  try {
    const sharedWorkerHost = await app.step('start Vite dev server on SharedWorker plane', () =>
      app.devServer({ name: 'shared-worker', env: baseEnv }),
    );
    await app.step('SharedWorker: mid-stream and pre-header aborts stop upstream and throw AbortError', () =>
      verifyPlane(app, sharedWorkerHost, standIn.url, 'shared-worker'),
    );

    const hostedServer = await app.step('start Vite dev server on Node host plane', () =>
      app.devServer({ name: 'node-host', env: { ...baseEnv, HOSTED: '1' } }),
    );
    await app.step('Node host: mid-stream and pre-header aborts stop upstream and throw AbortError', () =>
      verifyPlane(app, hostedServer, standIn.url, 'node-host'),
    );

    const inPageServer = await app.step('start Vite dev server for in-page sandbox plane', () =>
      app.devServer({ name: 'in-page', env: baseEnv }),
    );
    await app.step('in-page: mid-stream and pre-header aborts stop upstream and throw AbortError', async () => {
      const context = await app.browser();
      await context.addInitScript(() => {
        (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
      });
      await verifyPlane(app, inPageServer, standIn.url, 'in-page');
    });
  } finally {
    if (standIn.child.exitCode === null) {
      standIn.child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          standIn.child.kill('SIGKILL');
          resolve();
        }, 2000);
        standIn.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
});
