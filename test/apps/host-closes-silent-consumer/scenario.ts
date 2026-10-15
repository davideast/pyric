// A server process that stops talking without closing its socket must not
// stay online on the Node host, and a host that stops answering must not leave
// a server process waiting on a dead socket (#973, ADR-0019 as amended).
//
// Two long-lived `node --import @pyric/cli/register` processes, `frozen` and
// `running`, each mark themselves online, register
// `onDisconnect().set('offline')` and keep an RTDB listener. They register the
// onDisconnect over the remote handle's raw relay channel, which sends the same
// `worker-op` the Kotlin, Swift and Flutter clients send.
//
// A paused process is the half-open socket: SIGSTOP stops the process, but the
// kernel keeps its loopback connection open, so the host sees no close frame,
// no FIN and no traffic. That is the state of a process held at a debugger
// breakpoint, a job stopped with Ctrl+Z, or an app the OS suspended.
//
// Part one pauses `frozen`. The host closes its socket once the liveness
// window passes and runs its onDisconnect, while `running`, which heartbeats,
// stays online. Resumed, `frozen` reconnects and its listener hears again.
// Part two pauses the host itself. `running` notices within its 45s liveness
// timeout that the host stopped answering, and reconnects once it resumes.
//
// The host's window is shortened through PYRIC_TEST_PEER_LIVENESS_MS, a
// test-only knob read when the host starts; it stays longer than the clients'
// 15s heartbeat so `running` proves heartbeats keep a socket open.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, sleep, type AppProcess } from '../driver.ts';

declare const observer: { read(path: string): Promise<unknown>; write(path: string, value: unknown): Promise<void> };

const WINDOW_MS = 40_000;
const HEARTBEAT_MS = 15_000;
const CLIENT_LIVENESS_MS = 45_000;
/** The lazy handle's once-per-drop line: `pyric: <reason> at <url>; the next op connects again, ...`. */
const LOSS_LINE = /pyric: (.+) at http:\/\/127\.0\.0\.1:\d+; the next op connects again/;

/** Settles `pending` within `ms`, or fails naming the call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

function read(page: Page, path: string): Promise<unknown> {
  return within(`observer.read(${path})`, 15_000, page.evaluate((target) => observer.read(target), path));
}

/** Writes from the page, retrying while its own connection recovers from a paused host. */
async function write(page: Page, path: string, value: unknown): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await within(`observer.write(${path})`, 12_000, page.evaluate(([target, next]) => observer.write(target, next), [path, value] as const));
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(1_000);
    }
  }
}

/** Polls `path` until it reads `expected`; returns the milliseconds since `since`, or undefined. */
async function readsWithin(page: Page, path: string, expected: unknown, since: number, limitMs: number): Promise<number | undefined> {
  while (Date.now() - since < limitMs) {
    if (await read(page, path) === expected) return Date.now() - since;
    await sleep(500);
  }
  return undefined;
}

/** Writes `value` to `messages/latest` and waits until `consumer` logs that it heard it. */
async function heardAfter(page: Page, consumer: AppProcess, name: string, value: string): Promise<void> {
  const since = consumer.mark();
  await write(page, 'messages/latest', value);
  await consumer.waitForLog(new RegExp(`${name} heard "${value}"`), { since, timeoutMs: 30_000 });
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server with a 40s liveness window', () =>
    app.devServer({ env: { PYRIC_TEST_PEER_LIVENESS_MS: String(WINDOW_MS) } }));
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'observer' in window);

  const consumers = await app.step('two server processes go online, register onDisconnect and listen', async () => {
    const start = async (name: string): Promise<AppProcess> => {
      const consumer = app.serverProcess('consumer.mjs', [name, host.url]);
      await consumer.waitForLog(new RegExp(`${name} online`), { timeoutMs: 30_000 });
      return consumer;
    };
    const frozen = await start('frozen');
    const running = await start('running');
    for (const name of ['frozen', 'running']) {
      assert.equal(await read(page, `status/${name}`), 'online', name);
    }
    await heardAfter(page, frozen, 'frozen', 'before');
    await running.waitForLog(/running heard "before"/, { timeoutMs: 10_000 });
    return { frozen, running };
  });

  try {
    const pausedAt = await app.step('the frozen process is paused, so its socket stays open and silent', async () => {
      consumers.frozen.pause();
      const at = Date.now();
      await sleep(2_000);
      assert.equal(await read(page, 'status/frozen'), 'online', 'the paused process closed its socket on its own');
      return at;
    });

    await app.step('the host closes the silent process, so its onDisconnect sets offline', async () => {
      const limit = WINDOW_MS + 20_000;
      const offlineMs = await readsWithin(page, 'status/frozen', 'offline', pausedAt, limit);
      assert.ok(offlineMs !== undefined, `the paused process was still online ${limit / 1000}s after it was paused`);
    });

    await app.step('the running process, which heartbeats, stays online past the window', async () => {
      const remaining = WINDOW_MS + HEARTBEAT_MS - (Date.now() - pausedAt);
      if (remaining > 0) await sleep(remaining);
      assert.equal(await read(page, 'status/running'), 'online');
      assert.equal(consumers.running.output.match(LOSS_LINE), null, 'the running process lost its connection');
    });

    await app.step('resumed, the frozen process reconnects and its listener hears again', async () => {
      const since = consumers.frozen.mark();
      consumers.frozen.resume();
      await consumers.frozen.waitForLog(LOSS_LINE, { since, timeoutMs: 20_000 });
      await heardAfter(page, consumers.frozen, 'frozen', 'after-resume');
    });

    const hostPausedAt = await app.step('the host is paused, and the running process notices it stopped answering', async () => {
      const since = consumers.running.mark();
      host.process.pause();
      const at = Date.now();
      const match = await consumers.running.waitForLog(LOSS_LINE, { since, timeoutMs: CLIENT_LIVENESS_MS + 15_000 });
      assert.ok(host.process.paused, 'the host was resumed before the loss was reported');
      assert.match(match[1] ?? '', /sent nothing for 45s/);
      return at;
    });

    await app.step('the host resumes, and the running process reconnects and hears again', async () => {
      host.process.resume();
      assert.ok(Date.now() - hostPausedAt < CLIENT_LIVENESS_MS + 15_000);
      await heardAfter(page, consumers.running, 'running', 'after-host-resume');
    });
  } finally {
    // A failed step must not leave a stopped process behind; the run's
    // teardown also resumes a paused process before it ends it.
    for (const child of [consumers.frozen, consumers.running, host.process]) {
      try { child.resume(); } catch { /* already gone */ }
    }
  }
});
