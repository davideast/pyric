// An agent's MCP call through `pyric mcp` reaches the sandbox a page holds in
// its SharedWorker (#1468). `pyric sandbox --bridge` serves the page; Chromium
// opens it, so the SharedWorker holds the sandbox and registers as the bridge
// peer. A stdio client runs the installed `pyric mcp --attach`, which finds
// the host through `.pyric/serve.json`, and writes a Firestore note with
// `firestore_create_document`. The page's listener sees the note.
//
// The standalone `pyric bridge` lost its browser socket in #1468; this is
// the path an agent that drives a page takes instead, and it must keep
// working with that change.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

interface Note { listening: boolean; data: unknown; error: string | null }
declare const note: Note;

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs / 1000}s`);
    await sleep(250);
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function sandboxConnected(url: string): Promise<boolean> {
  try {
    const health = await (await fetch(`${url}/__pyric/health`)).json() as { sandboxConnected?: boolean };
    return health.sandboxConnected === true;
  } catch {
    return false;
  }
}

/** Run `pyric mcp --attach` over stdio from the app directory and return the tool's result. */
async function mcpCall(app: App, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: { ok: boolean; summary: string } }> {
  const { code, output } = await app.command('node', ['mcp-call.mjs', name, JSON.stringify(args)], { timeoutMs: 60_000 });
  assert.equal(code, 0, output);
  const line = output.split('\n').find((entry) => entry.startsWith('result '));
  assert.ok(line, `no result line in:\n${output}`);
  assert.match(output, /attached to a running serve/, output);
  return JSON.parse(line.slice('result '.length));
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;

  await app.step('pyric sandbox --bridge serves the page', async () => {
    const host = app.pyricProcess(['sandbox', '--bridge', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    await waitFor(`pyric sandbox did not serve ${url}/__pyric/init.json`, async () => {
      if (!host.running) throw new Error(`pyric sandbox exited (code ${await host.exited}):\n${host.output}`);
      return answers(`${url}/__pyric/init.json`);
    }, 90_000);
  });

  const page = await app.step('the page listens to the note, with the sandbox in its SharedWorker', async () => {
    const page = await app.page(`${url}/`);
    await page.waitForFunction(() => typeof note === 'object' && note.listening, undefined, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => note.error), null);
    assert.equal(await page.evaluate(() => note.data), null);
    const cdp = await page.context().newCDPSession(page);
    const { targetInfos } = await cdp.send('Target.getTargets') as { targetInfos: Array<{ type: string; url: string }> };
    const sharedWorkers = targetInfos.filter((target) => target.type === 'shared_worker');
    assert.ok(
      sharedWorkers.some((target) => target.url.startsWith(`${url}/__pyric/`)),
      `no pyric SharedWorker among the browser's targets: ${JSON.stringify(targetInfos)}`,
    );
    return page;
  });

  await app.step('the SharedWorker registers as the bridge peer', () =>
    waitFor('the host did not report a connected sandbox', () => sandboxConnected(url)));

  await app.step('firestore_create_document through pyric mcp reaches the page', async () => {
    const result = await mcpCall(app, 'firestore_create_document', {
      path: 'notes/from-agent',
      data: { text: 'written by an agent through pyric mcp' },
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.body.ok, true, JSON.stringify(result));
    await page.waitForFunction(
      () => (note.data as { text?: string } | null)?.text === 'written by an agent through pyric mcp',
      undefined,
      { timeout: 15_000 },
    );
  });

  await app.step('firestore_get_document through pyric mcp reads what the page sees', async () => {
    const result = await mcpCall(app, 'firestore_get_document', { path: 'notes/from-agent' });
    assert.equal(result.body.ok, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.body), /written by an agent through pyric mcp/);
  });
});
