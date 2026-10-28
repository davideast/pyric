// A Storage ruleset is not Firestore rules (#1328, FS2-ENF-2). Production
// won't deploy a `service firebase.storage` ruleset to Firestore, so no
// pyric plane loads one either. The page's in-page sandbox, given a Storage
// allow-all ruleset through `setRules`, denies its read and write of c/1 and
// names the service in its rules status. A project whose `firestore.rules`
// is a Storage ruleset makes `pyric sandbox` refuse it at load, with the
// same reason, before it runs the app's command.
//
// The Node host's `firestore_simulator_create` MCP tool refuses what
// production won't load too (#1329, FS2-ENF-3a, FS2-ENF-3b). An agent that
// finds the host through `.pyric/serve.json` and seeds it with a Storage
// ruleset, or with one that does not parse, gets `ok: false` with the
// reason `rules.set` gives, and the rules `pyric rules set` locked stay in
// force for the page and for a registered Node process.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { scenario, type App } from '../driver.ts';

declare const wrongService: { run(): Promise<{ read: string; write: string; status: string[] }> };
declare const hostedRules: { write(id: string): Promise<{ open: string; locked: string }> };

const REASON = "Firestore rules did not compile: Expected 'service cloud.firestore', got 'service firebase.storage'.";

/** Writes to open/ are allowed; everything else is denied. */
const OPEN_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} {
      allow read, write: if true;
    }
  }
}`;

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const UNPARSEABLE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true }
  }
}`;

const LOCKED_RULES_IN_FORCE = { open: 'ok', locked: 'permission-denied' };

interface ToolBody {
  ok: boolean;
  summary?: string;
  data?: { code?: string };
}

/**
 * An MCP session on the host `.pyric/serve.json` names, as `pyric mcp` opens
 * one: POST `/__pyric/mcp` with the host's instance id.
 */
function hostMcp(app: App) {
  const pointer = JSON.parse(app.readFile('.pyric/serve.json')) as { url: string; instanceId: string };
  let sessionId: string | null = null;
  let nextId = 1;
  async function request(method: string, params: Record<string, unknown>, notification = false): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-pyric-instance-id': pointer.instanceId,
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
    const res = await fetch(`${pointer.url}/__pyric/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    const text = await res.text();
    assert.ok(res.ok, `MCP ${method} answered ${res.status}: ${text}`);
    if (notification) return null;
    const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
    const message = JSON.parse(line.replace(/^data:\s*/, '')) as { result?: unknown; error?: { message: string } };
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return message.result;
  }
  return {
    async initialize(): Promise<void> {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'firestore-rules-wrong-service', version: '0' } });
      await request('notifications/initialized', {}, true);
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolBody> {
      const result = await request('tools/call', { name, arguments: args }) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0]!.text) as ToolBody;
    },
  };
}

async function serverWrites(app: App, id: string, env: Record<string, string>) {
  const { output } = await app.serverScript('client.mjs', [id], { env, timeoutMs: 30_000 });
  assert.match(output, /^client done$/m, output);
  const outcome = (name: string) => {
    const match = output.match(new RegExp(`^${name} (.*)$`, 'm'));
    assert.ok(match, `no ${name} line in:\n${output}`);
    return match[1]!;
  };
  return { open: outcome('open'), locked: outcome('locked') };
}

export default scenario(async (app) => {
  const host = await app.step('start the dev server', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  const page = await app.step('the in-page sandbox denies c/1 under a Storage ruleset and names the service', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'wrongService' in window, undefined, { timeout: 30_000 });
    const result = await page.evaluate(() => wrongService.run());
    // Refused as an unloadable ruleset is: the request fails with the reason.
    for (const outcome of [result.read, result.write]) {
      assert.notEqual(outcome, 'ok');
      assert.ok(outcome.includes(REASON), outcome);
    }
    assert.deepEqual(result.status, [REASON]);
    return page;
  });

  await app.step('pyric rules set locks the Node host to writes under open/', async () => {
    const result = await app.pyric(['rules', 'set', '--service', 'firestore', '--rules', OPEN_ONLY], { env });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await page.evaluate(() => hostedRules.write('before')), LOCKED_RULES_IN_FORCE);
  });

  const mcp = hostMcp(app);
  await app.step('an agent opens an MCP session on the discovered host', () => mcp.initialize());

  const refusals: Array<[string, string, RegExp]> = [
    ['a Storage ruleset', STORAGE_ALLOW_ALL, new RegExp(`^${REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)],
    ['a ruleset that does not parse', UNPARSEABLE, /^Firestore rules did not parse at line 4, column \d+: /],
  ];
  for (const [label, rules, reason] of refusals) {
    const id = label.replaceAll(' ', '-');
    await app.step(`firestore_simulator_create refuses ${label} with the reason rules.set gives`, async () => {
      const body = await mcp.callTool('firestore_simulator_create', { rules, documents: { [`locked/${id}`]: { from: 'tool' } } });
      assert.equal(body.ok, false, JSON.stringify(body));
      assert.match(body.summary ?? '', reason);
      assert.equal(body.data?.code, 'RULES_REFUSED');
    });

    await app.step(`the locked rules stay in force for the page and a Node process after ${label}`, async () => {
      assert.deepEqual(await page.evaluate((pageId) => hostedRules.write(pageId), `page-${id}`), LOCKED_RULES_IN_FORCE);
      assert.deepEqual(await serverWrites(app, `server-${id}`, env), LOCKED_RULES_IN_FORCE);
    });
  }

  await app.step('pyric sandbox refuses a project whose firestore.rules is a Storage ruleset', async () => {
    const port = await app.freePort();
    const cli = join('..', 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
    const result = await app.command(
      'node',
      [cli, 'sandbox', '--no-open', '--port', String(port), '--', 'node', '-e', 'console.log("app command ran")'],
      { cwd: 'wrong-service', timeoutMs: 90_000 },
    );
    assert.notEqual(result.code, 0, result.output);
    assert.ok(result.output.includes(REASON), result.output);
    assert.doesNotMatch(result.output, /app command ran/);
  });
});
