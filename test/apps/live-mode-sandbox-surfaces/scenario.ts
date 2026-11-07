/**
 * On a live host, pyric's surfaces that only know the sandbox refuse rather
 * than answer from it, through the packed packages: a rooms page on
 * `vite dev` with `pyricLive({ project })` signs its user in, and an agent
 * calls the host's MCP route (`/__pyric/mcp`) and a pyric command's route
 * (`/__pyric/hosted/method`).
 *
 * With no tab of the app open, a Firestore and a Realtime Database read from
 * MCP, and a Firestore and a Realtime Database read from a command, are
 * refused with live mode's code, never answered from the empty sandbox. A
 * Firestore rules write from a command is refused before and after the page
 * signs in. The sandbox event log still answers to
 * `pyric sandbox events`, and the chip's Identity tab opens. Production
 * received nothing for any of it: the replay server's own log of what it
 * received holds the page's sign-in and nothing else.
 *
 * Production is a replay server this scenario starts (`../replay/`),
 * playing `live-mode-traffic.json`. The app reaches it with the SDK's own
 * emulator connector (`?backend=` on the page). Like every app scenario this
 * runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const FIXTURE = fileURLToPath(new URL('../replay/fixtures/live-mode-traffic.json', import.meta.url));
const PROJECT = 'demo-live-traffic';
const REFUSED = 'PYRIC_LIVE_REFUSED';
const CLOSED_RULES = "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{p=**} { allow read, write: if false; } } }";

declare function signIn(): Promise<string>;
declare function currentUid(): string | null;

interface Received {
  rpc: string;
  as: string | null;
}

interface Replay {
  origin: string;
  received(): Promise<Received[]>;
  unmatched(): Promise<unknown[]>;
}

/** A tool's or a command's answer, as both routes give it. */
interface Answer {
  ok: boolean;
  summary: string;
  data?: { code?: string } & Record<string, unknown>;
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([FIXTURE]));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  return {
    origin: endpoints.origin,
    received: () => receivedBy(endpoints.origin) as Promise<Received[]>,
    unmatched: () => unmatchedBy(endpoints.origin),
  };
}

/** A tool call's result on the MCP route: whether it is an error, and its text block. */
interface ToolResult {
  isError: boolean;
  text: string;
}

/** A data tool's text block, which holds its answer as JSON. */
function answerOf(result: ToolResult): Answer {
  return JSON.parse(result.text) as Answer;
}

/** One JSON-RPC session with the host's MCP route, as an agent's editor holds it. */
async function mcpSession(base: string): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const response = await fetch(`${base}/__pyric/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const text = await response.text();
    if (text.length === 0) return null;
    const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
    return JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, unknown>;
  };
  const init = await post({ id: nextId++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-mode-sandbox-surfaces', version: '0' } } });
  assert.ok(init && !init.error, `initialize failed: ${JSON.stringify(init)}`);
  await post({ method: 'notifications/initialized', params: {} });
  return async (name, args) => {
    const call = await post({ id: nextId++, method: 'tools/call', params: { name, arguments: args } }) as { result?: { isError?: boolean; content: Array<{ type: string; text?: string }> }; error?: unknown };
    assert.ok(call?.result, `tools/call ${name} failed: ${JSON.stringify(call)}`);
    const text = call.result.content.find((block) => block.type === 'text')?.text ?? '';
    return { isError: call.result.isError === true, text };
  };
}

/** One direct command through `/__pyric/hosted/method`, as a pyric command sends it. */
async function hostedMethod(app: App, base: string, key: string, args: Record<string, unknown>): Promise<Answer> {
  const health = await (await fetch(`${base}/__pyric/health`)).json() as { instanceId: string };
  const response = await fetch(`${base}/__pyric/hosted/method`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: health.instanceId, projectDir: app.dir, key, args }),
  });
  return await response.json() as Answer;
}

/** The answer carries live mode's refusal code. */
function assertRefused(answer: Answer, what: string): void {
  assert.equal(answer.ok, false, `${what} answered: ${JSON.stringify(answer)}`);
  assert.equal(answer.data?.code, REFUSED, `${what}: ${JSON.stringify(answer)}`);
}

/** The chip, opened. */
async function openChip(page: Page): Promise<Locator> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  const header = chip.locator('.panel-header [data-chip-live]');
  if (await header.count() === 0) await chip.locator('[data-expand]').click();
  return chip;
}

/** The replay server received nothing while `run` ran, and nothing went to another host. */
async function sendsNothing<T>(app: App, replay: Replay, run: () => Promise<T>): Promise<T> {
  const before = await replay.received();
  const blockedBefore = blockedLines(app).length;
  const result = await run();
  await sleep(500);
  assert.deepEqual(await replay.received(), before, 'the replay server received a request for a refused call');
  assert.deepEqual(blockedLines(app).slice(blockedBefore), [], 'a refused call tried another host');
  return result;
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  const replay = await app.step('start the replay server that plays production for the host\'s project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive({ project }): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const mcp = await mcpSession(host.url);

  await app.step('with no tab open, MCP Firestore and Realtime Database reads and a command\'s read are refused, never answered from the sandbox', async () => {
    await sendsNothing(app, replay, async () => {
      assertRefused(answerOf(await mcp('firestore_get_document', { path: 'rooms/lobby' })), 'firestore_get_document');
      assertRefused(answerOf(await mcp('rtdb_crawl_structure', { path: '/' })), 'rtdb_crawl_structure');
      assertRefused(await hostedMethod(app, host.url, 'firestore.getDoc', { path: 'rooms/lobby' }), 'hosted firestore.getDoc');
      assertRefused(await hostedMethod(app, host.url, 'database.get', { path: '/rooms' }), 'hosted database.get');
    });
  });

  await app.step('a command\'s Firestore rules write is refused', async () => {
    await sendsNothing(app, replay, async () => {
      assertRefused(await hostedMethod(app, host.url, 'rules.set', { service: 'firestore', rules: CLOSED_RULES }), 'hosted rules.set');
    });
  });

  await app.step('the replay server has received nothing yet', async () => {
    assert.deepEqual(await replay.received(), []);
  });

  const page = await app.step('the page signs its user in through production', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting');
    assert.equal(await opened.evaluate(() => document.querySelector('#status')?.textContent), 'Ready');
    assert.equal(await opened.evaluate(() => signIn()), 'user-reader');
    return opened;
  });

  await app.step('with the page signed in, a command\'s Firestore rules write is still refused', async () => {
    await sendsNothing(app, replay, async () => {
      assertRefused(await hostedMethod(app, host.url, 'rules.set', { service: 'firestore', rules: CLOSED_RULES }), 'hosted rules.set');
    });
  });

  await app.step('the sandbox event log still answers to pyric sandbox events', async () => {
    const run = await sendsNothing(app, replay, () => app.pyric(['sandbox', 'events', '--limit', '20']));
    assert.equal(run.code, 0, run.output);
    assert.ok(!run.output.includes(REFUSED), run.output);
  });

  await app.step('the chip\'s Identity tab is visible and opens', async () => {
    const chip = await openChip(page);
    const tab = chip.locator('[data-chip-tab=identity]');
    await tab.waitFor({ state: 'visible', timeout: 15_000 });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    await chip.locator('#pyric-view').waitFor({ state: 'visible', timeout: 15_000 });
  });

  await app.step("the Identity tab shows the production user the page signed in, with none of the sandbox's user controls", async () => {
    const chip = await openChip(page);
    await chip.locator('[data-live-identity="signed-in"]').waitFor({ timeout: 15_000 });
    assert.equal(await chip.locator('[data-live-identity-view] .identity-facts dd').first().textContent(), 'user-reader');
    for (const selector of ['[data-identity-query]', '[data-switch-user]', '[data-create-user]', '[data-toggle-bypass]']) {
      assert.equal(await chip.locator(selector).count(), 0, selector);
    }
  });

  await app.step("Sign out signs the page's own Auth out, and the user stays among the recent users", async () => {
    const chip = await openChip(page);
    assert.equal(await page.evaluate(() => currentUid()), 'user-reader');
    await chip.locator('[data-live-sign-out]').click();
    await chip.locator('[data-live-identity="signed-out"]').waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(() => currentUid()), null);
    await chip.locator('[data-live-recent-user="user-reader"]').waitFor({ timeout: 15_000 });
  });

  await app.step('production received only the page\'s sign-in, by the replay server\'s own log', async () => {
    const received = await replay.received();
    assert.ok(received.length > 0, 'the replay server received the sign-in');
    assert.deepEqual(received.filter((entry) => entry.rpc !== 'auth'), [], 'the replay server received a data request');
    assert.deepEqual(await replay.unmatched(), []);
    assert.deepEqual(blockedLines(app), []);
    await host.process.stop();
  });
});
