// A Node server process keeps writing while the hosted dev server restarts
// (#1107, registry row rtdb-modular#HD2). `writer.mjs` runs under
// `node --import @pyric/cli/register`, which routes firebase-admin to the
// host through the Node remote client, and calls `ref('ticks/<n>').set(n)`
// every 100 ms. A few seconds in, the scenario edits vite.config.js, which is
// what restarts a Vite dev server in a user's project. The writer keeps going
// until it has seen the connection drop and has issued 30 more writes after
// the server is back; then the scenario tells it to stop. So the restart
// always lands inside the writes, however long Vite takes to notice the edit.
//
// The writer uses firebase-admin, whose Node remote client this scenario
// covers. The modular `firebase/database` SDK in a registered process runs the
// web hosted client instead (#1082); row HD1 covers its drops.
//
// In production, firebase-admin's Database runs the `@firebase/database` core,
// which queues a write issued while it is offline and sends an in-flight write
// again after it reconnects, so a brief outage costs a delay and no errors.
// The scenario asserts that: every write resolves, every tick is stored, and
// the process logs no unhandled rejection. A client SDK process that lives
// across the restart keeps its Firebase config: a page with another config
// that loads after the restart is the one refused.
//
// Before asserting, it prints what the writer saw: how many writes failed,
// with which codes, and when, relative to the config edit and to Vite's
// "server restarted" line. Nothing waits on a timeout: each wait ends on an
// event (a log line or a write), and its bound only fails the scenario.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenario, sleep, type App, type AppProcess, type DevServer } from '../driver.ts';

/** The writer never runs past two minutes of writes. */
const MAX_TICKS = 1200;
const STEADY_TICKS = 30;
/** Writes issued after Vite reports the restart before the writer stops. */
const TICKS_AFTER_RESTART = 30;
/** The line the Node remote client logs when the host drops its connection. */
const DROP_WARNING = /^pyric: remote sandbox connection closed/m;

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

async function untilIssuedAfter(writer: AppProcess, at: number, count: number, limitMs: number, diagnose: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (ticksOf(writer).filter((tick) => tick.issuedAt > at).length < count) {
    assert.ok(writer.running, `the writer exited before ${count} writes after the restart:\n${writer.output}`);
    const isPastDeadline = Date.now() >= deadline;
    if (isPastDeadline) {
      assert.fail(`the writer issued fewer than ${count} writes within ${limitMs / 1000}s of the restart:\n${await diagnose()}\n${writer.output}`);
    }
    await sleep(100);
  }
}

/** The writer's process state from /proc (R, S, T for stopped, Z, ...), or why it could not be read. */
function processState(pid: number | undefined): string {
  if (pid === undefined) return 'no pid';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'unreadable';
  } catch (error) {
    return `unreadable (${(error as Error).message})`;
  }
}

/**
 * What a stall looked like (#1268): whether the writer process still runs, and
 * which ticks the host stored after the restart. Stored ticks the writer never
 * logged mean its writes reached the host and its output was lost; none mean
 * its writes stopped reaching the host.
 */
async function stallDiagnosis(app: App, url: string, writer: AppProcess, restartedAt: number): Promise<string> {
  const logged = ticksOf(writer);
  const lastBeforeRestart = Math.max(-1, ...logged.filter((tick) => tick.issuedAt <= restartedAt).map((tick) => tick.n));
  const loggedAfter = logged.filter((tick) => tick.n > lastBeforeRestart).map((tick) => tick.n);
  let storedAfter: string;
  try {
    const stored = await storedTicks(app, url, 20_000);
    storedAfter = JSON.stringify(stored.filter((n) => n > lastBeforeRestart));
  } catch (error) {
    storedAfter = `could not be read: ${(error as Error).message.split('\n')[0]}`;
  }
  return [
    `[#1268 diagnosis] writer process: ${writer.running ? 'running' : 'exited'}, pid ${writer.pid}, state ${processState(writer.pid)}`,
    `[#1268 diagnosis] last tick issued before the restart and logged: ${lastBeforeRestart}`,
    `[#1268 diagnosis] ticks after it the writer logged: ${JSON.stringify(loggedAfter)}`,
    `[#1268 diagnosis] ticks after it the host stored: ${storedAfter}`,
  ].join('\n');
}

async function storedTicks(app: App, url: string, timeoutMs?: number): Promise<number[]> {
  const { output } = await app.serverScript('ticks.mjs', [], { env: { PYRIC_SANDBOX: `remote:${url}` }, timeoutMs });
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
    const writer = app.serverProcess('writer.mjs', [String(MAX_TICKS)], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
    await untilSettled(writer, STEADY_TICKS, 30_000);
    return writer;
  });

  const holder = await app.step('start a client SDK process; its first write resolves', async () => {
    const holder = app.serverProcess('holder.mjs', [], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
    await holder.waitForLog(/^holder 0 \{"ok":true\}$/m, { timeoutMs: 30_000 });
    return holder;
  });

  const editedAt = Date.now();
  const restartedAt = await app.step('edit vite.config.js; Vite restarts the server', () => restartByConfigEdit(app, host));

  await app.step('the writer sees the connection drop', () =>
    writer.waitForLog(DROP_WARNING, { timeoutMs: 30_000 }).catch(() => {
      assert.fail(`the writer never logged a dropped connection, so the restart did not happen during its writes:\n${writer.output}`);
    }));

  await app.step(`the writer issues ${TICKS_AFTER_RESTART} writes after the restart, then stops`, async () => {
    await untilIssuedAfter(writer, restartedAt, TICKS_AFTER_RESTART, 60_000, () => stallDiagnosis(app, host.url, writer, restartedAt));
    app.writeFile('writer-stop', '');
  });

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
    // A restart on the same URL is not a stopped sandbox: no call reports the URL as stale.
    assert.doesNotMatch(writer.output, /is stale/);
    const issued = Number(writer.output.match(/^writer done (\d+)$/m)?.[1]);
    assert.equal(ticks.length, issued, `the writer logged ${ticks.length} outcomes for ${issued} writes`);
  });

  await app.step('every write resolves, as the SDK queues and re-sends across a brief outage', () => {
    const failed = ticks.filter((tick) => !tick.ok);
    assert.deepEqual(failed.map((tick) => `${tick.n}: [${tick.code}] ${tick.message}`), []);
  });

  await app.step('every tick is stored', () => {
    assert.deepEqual(stored, Array.from({ length: ticks.length }, (_, n) => n));
  });

  // After the restart the client SDK process reattaches with the new host's
  // boot id, read from its init.json, so the host holds its config as
  // verified. A page whose config names another storage bucket is refused,
  // and the process is not evicted.
  await app.step('the client SDK process writes after the restart', async () => {
    app.writeFile('holder-go-1', '');
    await holder.waitForLog(/^holder 1 .*$/m, { timeoutMs: 30_000 });
    assert.match(holder.output, /^holder 1 \{"ok":true\}$/m, holder.output);
  });

  await app.step('a page whose config names another storage bucket is refused', async () => {
    const page = await app.page(`${host.url}/conflict.html`);
    await page.waitForFunction(() => 'conflict' in window);
    const result = await page.evaluate(() =>
      (window as unknown as { conflict: { write(): Promise<{ ok: boolean; code?: string; message?: string }> } }).conflict.write());
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'app/multiple-configs-not-supported', JSON.stringify(result));
    assert.match(result.message ?? '', /differs on: storageBucket/);
    await page.close();
  });

  await app.step('the client SDK process keeps writing after that page loaded', async () => {
    app.writeFile('holder-go-2', '');
    await holder.waitForLog(/^holder done$/m, { timeoutMs: 30_000 });
    assert.match(holder.output, /^holder 2 \{"ok":true\}$/m, holder.output);
  });
});
