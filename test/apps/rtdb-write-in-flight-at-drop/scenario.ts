// RTDB calls in flight when the hosted socket drops (#1088). The page issues a
// `set` and the presence sample's `onDisconnect().set()`, which the Firebase
// docs call without a rejection handler. The socket drops after the page has
// handed both frames to it and before the host has answered either.
//
// `@firebase/database` sends an outstanding write again after it reconnects
// and resolves it on the new acknowledgment, and drops an onDisconnect it had
// already sent without settling it. So the page sees no unhandled rejection,
// the write resolves after the reconnect, and the host stores its value.
//
// Chromium's socket to the hosted dev server runs through a Playwright
// WebSocket route. On the first socket the route keeps the two frames from
// the host and then closes the socket, so both are in flight at the drop;
// every later socket passes through unchanged. Nothing waits on a timeout.
import assert from 'node:assert/strict';
import type { Page, WebSocketRoute } from '@playwright/test';
import { scenario, sleep, type App } from '../driver.ts';

interface Outcome { state: 'idle' | 'pending' | 'fulfilled' | 'rejected'; message?: string }
declare const calls: {
  connected(): boolean | null;
  connections(): number;
  issue(): void;
  outcomes(): { write: Outcome; arm: Outcome };
  rejections(): string[];
};

/** Settles `pending` within `ms`, or fails naming the browser call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

function outcomes(page: Page): Promise<{ write: Outcome; arm: Outcome }> {
  return within('page.evaluate(() => calls.outcomes())', 5_000, page.evaluate(() => calls.outcomes()));
}

function rejections(page: Page): Promise<string[]> {
  return within('page.evaluate(() => calls.rejections())', 5_000, page.evaluate(() => calls.rejections()));
}

/** Polls until the page has seen `.info/connected` turn true `count` times and is connected now. */
async function untilConnections(page: Page, count: number, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const seen = await within('page.evaluate(() => calls.connections())', 5_000, page.evaluate(() => calls.connections()));
    const connected = await within('page.evaluate(() => calls.connected())', 5_000, page.evaluate(() => calls.connected()));
    const reached = seen >= count && connected === true;
    if (reached) return;
    assert.ok(Date.now() < deadline, `.info/connected turned true ${seen} times, not ${count}, within ${limitMs / 1000}s`);
    await sleep(100);
  }
}

/** Polls until the write is no longer pending. */
async function settledWrite(page: Page, limitMs: number): Promise<Outcome> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const { write } = await outcomes(page);
    const settled = write.state === 'fulfilled' || write.state === 'rejected';
    if (settled) return write;
    assert.ok(Date.now() < deadline, `the write did not settle within ${limitMs / 1000}s: ${JSON.stringify(write)}`);
    await sleep(100);
  }
}

async function readRoom(app: App, url: string): Promise<unknown> {
  const { output } = await app.serverScript('room.mjs', [], { env: { PYRIC_SANDBOX: `remote:${url}` } });
  const line = output.match(/^room (.*)$/m);
  assert.ok(line, `room.mjs printed no value:\n${output}`);
  return JSON.parse(line[1]!);
}

/** The worker operation a frame from the page carries, if any. */
function operationOf(data: string | Buffer): { method?: string; path?: string } | undefined {
  try {
    const frame = JSON.parse(String(data)) as { type?: string; message?: { t?: string; method?: string; path?: string } };
    const isOperation = frame.type === 'worker-message' && frame.message?.t === 'op';
    return isOperation ? frame.message : undefined;
  } catch {
    return undefined;
  }
}

const isWrite = (op: { method?: string; path?: string }): boolean => op.method === 'rtdb.set' && op.path === '/rooms/r1';
const isArm = (op: { method?: string; path?: string }): boolean => op.method === 'rtdb.onDisconnectSet' && op.path === '/status/alice';

/**
 * Routes the page's hosted sockets. Once `arm()` is called, the current socket
 * keeps the write and the onDisconnect from the host and closes when it has
 * both. Every other frame, and every later socket, passes through.
 */
function socketDropper() {
  let armed = false;
  let dropped = false;
  const kept = { write: false, arm: false };
  const route = (page: WebSocketRoute): void => {
    const server = page.connectToServer();
    page.onMessage((data) => {
      const op = operationOf(data);
      const keeps = armed && !dropped && op !== undefined && (isWrite(op) || isArm(op));
      if (!keeps) { server.send(data); return; }
      if (isWrite(op)) kept.write = true;
      if (isArm(op)) kept.arm = true;
      const hasBoth = kept.write && kept.arm;
      if (!hasBoth) return;
      dropped = true;
      void page.close({ code: 4000, reason: 'dropped by the scenario' });
      void server.close();
    });
  };
  return { route, arm: () => { armed = true; }, dropped: () => dropped };
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const dropper = socketDropper();

  const page = await app.step('open the page; it connects', async () => {
    const context = await app.browser();
    await context.routeWebSocket(/\/__pyric\/sandbox/, dropper.route);
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'calls' in window, undefined, { timeout: 30_000 });
    await untilConnections(page, 1, 30_000);
    return page;
  });

  await app.step('issue a set and an onDisconnect; the socket drops with both in flight, and the page reconnects', async () => {
    dropper.arm();
    await within('page.evaluate(() => calls.issue())', 5_000, page.evaluate(() => calls.issue()));
    const deadline = Date.now() + 10_000;
    while (!dropper.dropped()) {
      assert.ok(Date.now() < deadline, 'the page did not send both calls within 10s');
      await sleep(50);
    }
    await untilConnections(page, 2, 30_000);
  });

  const write = await app.step('the page sees no unhandled rejection, and the onDisconnect never settles', async () => {
    const write = await settledWrite(page, 15_000);
    assert.deepEqual(await rejections(page), []);
    const { arm } = await outcomes(page);
    assert.equal(arm.state, 'pending');
    return write;
  });

  await app.step('the write resolves after the reconnect, and the host stores its value', async () => {
    assert.equal(write.state, 'fulfilled', write.message);
    assert.equal(await readRoom(app, host.url), 'written across the drop');
  });
});
