// A Node server process keeps writing while the hosted dev server restarts
// (#1107, registry row rtdb-modular#HD2). `writer.mjs` runs under
// `node --import @pyric/cli/register`, which routes firebase-admin to the
// host through the Node remote client, and calls `ref('ticks/<n>').set(n)`
// every 100 ms. A few seconds in, the scenario edits vite.config.js, which is
// what restarts a Vite dev server in a user's project, and the writer keeps
// going for a few seconds after the server is back.
//
// The writer uses firebase-admin, not the modular `firebase/database` SDK:
// under register the modular SDK gets an in-process sandbox that never
// reaches the host (#1082), so it would measure nothing about the drop.
//
// In production, firebase-admin's Database runs the `@firebase/database` core,
// which queues a write issued while it is offline and sends an in-flight write
// again after it reconnects, so a brief outage costs a delay and no errors.
// The scenario asserts that: every write resolves, every tick is stored, and
// the process logs no unhandled rejection.
//
// Before asserting, it prints what the writer saw: how many writes failed,
// with which codes, and when, relative to the config edit and to Vite's
// "server restarted" line. Nothing waits on a timeout: the writer runs for
// 12 seconds and then waits for its writes to settle.
import assert from 'node:assert/strict';
import { scenario, sleep, type App, type AppProcess, type DevServer } from '../driver.ts';

const TICKS = 120;
const STEADY_TICKS = 30;

interface Tick { n: number; issuedAt: number; settledAt: number; ok: boolean; code?: string | null; message?: string }

function ticksOf(writer: AppProcess): Tick[] {
  return [...writer.output.matchAll(/^tick (.*)$/gm)].map((line) => JSON.parse(line[1]!) as Tick);
}

async function untilSettled(writer: AppProcess, count: number, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (ticksOf(writer).filter((tick) => tick.ok).length < count) {
    assert.ok(writer.running, `the writer exited before ${count} writes resolved:\n${writer.output}`);
    assert.ok(Date.now() < deadline, `${count} writes did not resolve within ${limitMs / 1000}s:\n${writer.output}`);
    await sleep(100);
  }
}

/** Edits vite.config.js so Vite restarts the server in place; returns when it reports the restart. */
async function restartByConfigEdit(app: App, host: DevServer): Promise<number> {
  const mark = host.process.mark();
  const config = app.readFile('vite.config.js');
  const edited = config.replace('plugins: [pyric({ hosted: true })],', 'plugins: [pyric({ hosted: true })],\n  server: { headers: { "x-config-revision": "2" } },');
  assert.notEqual(edited, config, 'the edit did not apply to vite.config.js');
  app.writeFile('vite.config.js', edited);
  const [outcome] = await host.process.waitForLog(/server restarted|server restart failed/, { since: mark, timeoutMs: 60_000 });
  assert.equal(outcome, 'server restarted', `Vite reported: ${host.process.output.slice(mark).trim()}`);
  return Date.now();
}

async function storedTicks(app: App, url: string): Promise<number[]> {
  const { output } = await app.serverScript('ticks.mjs', [], { env: { PYRIC_SANDBOX: `remote:${url}` } });
  const line = output.match(/^ticks (.*)$/m);
  assert.ok(line, `ticks.mjs printed no ticks:\n${output}`);
  return JSON.parse(line[1]!) as number[];
}

function summarize(ticks: Tick[], stored: number[], editedAt: number, restartedAt: number): string {
  const failed = ticks.filter((tick) => !tick.ok);
  const codes = new Map<string, number>();
  for (const tick of failed) {
    const key = `[${tick.code}] ${tick.message}`;
    codes.set(key, (codes.get(key) ?? 0) + 1);
  }
  const relative = (at: number) => `${at - editedAt} ms`;
  const window = failed.length === 0
    ? 'none'
    : `issued ${relative(failed[0]!.issuedAt)} to ${relative(failed.at(-1)!.issuedAt)}, settled ${relative(Math.min(...failed.map((t) => t.settledAt)))} to ${relative(Math.max(...failed.map((t) => t.settledAt)))}`;
  const lastFailure = failed.at(-1)?.n ?? -1;
  const recovered = ticks.some((tick) => tick.ok && tick.n > lastFailure);
  const storedSet = new Set(stored);
  const failedButStored = failed.filter((tick) => storedSet.has(tick.n)).map((tick) => tick.n);
  const okButMissing = ticks.filter((tick) => tick.ok && !storedSet.has(tick.n)).map((tick) => tick.n);
  return [
    `writes: ${ticks.length}, failed: ${failed.length}, stored: ${stored.length}`,
    `times are relative to the vite.config.js edit; Vite reported "server restarted" at ${relative(restartedAt)}`,
    `failed writes: ${window}`,
    ...[...codes].map(([key, count]) => `  ${count} x ${key}`),
    `failed ticks: ${JSON.stringify(failed.map((tick) => tick.n))}`,
    `recovered on its own: ${recovered}`,
    `failed but stored: ${JSON.stringify(failedButStored)}`,
    `resolved but not stored: ${JSON.stringify(okButMissing)}`,
  ].join('\n');
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const writer = await app.step(`start the writer; ${STEADY_TICKS} writes resolve`, async () => {
    const writer = app.serverProcess('writer.mjs', [String(TICKS)], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
    await untilSettled(writer, STEADY_TICKS, 30_000);
    return writer;
  });

  const editedAt = Date.now();
  const restartedAt = await app.step('edit vite.config.js; Vite restarts the server', () => restartByConfigEdit(app, host));

  const exitCode = await app.step('the writer finishes its writes and exits', async () => {
    const code = await Promise.race([writer.exited, sleep(90_000).then(() => 'timeout' as const)]);
    assert.notEqual(code, 'timeout', `the writer did not exit within 90s:\n${writer.output}`);
    return code;
  });

  const stored = await app.step('read back the stored ticks', () => storedTicks(app, host.url));
  const ticks = ticksOf(writer);
  console.log(`node-client-host-restart measurement\n${summarize(ticks, stored, editedAt, restartedAt)}`);

  await app.step('the writer exits cleanly and logs no unhandled rejection', () => {
    assert.equal(exitCode, 0, writer.output);
    assert.doesNotMatch(writer.output, /unhandled rejection|uncaught exception/);
    assert.equal(ticks.length, TICKS, `the writer logged ${ticks.length} outcomes, not ${TICKS}`);
  });

  await app.step('every write resolves, as the SDK queues and re-sends across a brief outage', () => {
    const failed = ticks.filter((tick) => !tick.ok);
    assert.deepEqual(failed.map((tick) => `${tick.n}: [${tick.code}] ${tick.message}`), []);
  });

  await app.step('every tick is stored', () => {
    assert.deepEqual(stored, Array.from({ length: TICKS }, (_, n) => n));
  });
});
