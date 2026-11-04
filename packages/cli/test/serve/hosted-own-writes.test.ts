/**
 * A Node host in live mode refuses pyric's own writes (`hosted/own-writes.ts`):
 * a write operation from a page's pyric runtime or Studio, a write MCP tool,
 * and a direct command's write, each with the installed `@pyric/live`'s
 * refusal, before the write runs. Reads still answer, and the store is
 * unchanged. The same host without the refusal writes, so the refusal is
 * what stops them.
 *
 * Hosted persistence needs Node (`sqlite.ts`), so the scenario runs under
 * the `node` on PATH against the built `dist/` of `@pyric/cli` and
 * `@pyric/live`. `live-refusals.pw.ts` drives the MCP route and the direct
 * command route of a real live dev server.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliDist = resolve(import.meta.dir, '../../dist');
const liveDist = resolve(import.meta.dir, '../../../live/dist');

const SCENARIO = `
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedRuntime } from ${JSON.stringify(pathToFileURL(join(cliDist, 'serve/hosted/runtime.js')).href)};
import { liveWriteRefusal } from ${JSON.stringify(pathToFileURL(join(liveDist, 'refusal.js')).href)};

const OPEN_RULES = "rules_version = '2';\\nservice cloud.firestore { match /databases/{db}/documents { match /{p=**} { allow read, write: if true; } } }";

async function host(live) {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-own-writes-'));
  const frames = [];
  const waiters = new Set();
  const payload = { rules: OPEN_RULES, rulesHash: null, storageRules: null, storageRulesHash: null, bridgeUrl: null, seed: null,
    capture: false, hosted: true, projectKey: dir, sessionToken: 'own-writes', permissive: false, appOptions: { projectId: 'demo-own-writes' } };
  const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', (frame) => {
    frames.push(frame);
    for (const waiter of [...waiters]) waiter();
  }, dir, live ? { ownWriteRefusal: liveWriteRefusal } : {});
  const waitFor = (match) => new Promise((done) => {
    const check = () => { const found = frames.find(match); if (found) { waiters.delete(check); done(found); } };
    waiters.add(check);
    check();
  });
  let seq = 0;
  const op = async (session, message) => {
    const id = 'op-' + (++seq);
    runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'op', id, ...message } });
    const frame = await waitFor((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === id);
    return frame.message;
  };
  const tool = async (name, args) => {
    const id = 'tool-' + (++seq);
    runtime.receive({ type: 'tool-call', callerId: 'agent', id, name, args });
    return waitFor((m) => m.type === 'tool-result' && m.id === id);
  };
  const command = (key, args) => runtime.runMethod({ instanceId: runtime.instanceId, projectDir: dir, key, args, allowProduction: false }, {});
  const close = async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); };
  return { op, tool, command, close };
}

const outcome = {};
for (const live of [true, false]) {
  const h = await host(live);
  const name = live ? 'live' : 'sandbox';
  const pageWrite = await h.op('page-1', { method: 'setDoc', path: 'rooms/a', data: { v: 1 } });
  const studioWrite = await h.op('studio-1', { method: 'setDoc', path: 'rooms/b', data: { v: 1 }, issuer: 'studio' });
  const toolWrite = await h.tool('firestore_create_document', { path: 'rooms/c', data: { v: 1 } });
  const commandWrite = await h.command('firestore.setDoc', { path: 'rooms/d', data: { v: 1 } });
  const userWrite = await h.op('page-1', { method: 'auth.adminCreateUser', request: { uid: 'alice', email: 'alice@example.com' } });
  const reads = [];
  for (const path of ['rooms/a', 'rooms/b', 'rooms/c', 'rooms/d']) reads.push(await h.op('page-1', { method: 'getDoc', path }));
  const failedRead = reads.find((entry) => !entry.ok);
  const read = failedRead ?? { ok: true, value: { docs: reads.filter((entry) => entry.value?.exists === true) } };
  outcome[name] = {
    pageWrite: pageWrite.ok ? 'ok' : pageWrite.error.code + ': ' + pageWrite.error.message,
    studioWrite: studioWrite.ok ? 'ok' : studioWrite.error.code + ': ' + studioWrite.error.message,
    toolWrite: toolWrite.ok && toolWrite.result.ok ? 'ok' : (toolWrite.error?.code ?? 'tool-failed') + ': ' + (toolWrite.error?.message ?? toolWrite.result?.summary),
    commandWrite: commandWrite.ok ? 'ok' : commandWrite.data?.code + ': ' + commandWrite.summary,
    userWrite: userWrite.ok ? 'ok' : userWrite.error.code + ': ' + userWrite.error.message,
    read: read.ok ? 'ok' : read.error.code,
    documents: read.ok ? read.value.docs.length : -1,
  };
  await h.close();
}
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

describe('a Node host in live mode', () => {
  it("refuses pyric's own writes from every client, and still answers reads", () => {
    for (const built of [join(cliDist, 'serve/hosted/runtime.js'), join(liveDist, 'refusal.js')]) {
      if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'pyric-own-writes-scenario-'));
    try {
      const file = join(dir, 'scenario.mjs');
      writeFileSync(file, SCENARIO);
      const result = spawnSync('node', [file], { encoding: 'utf8', timeout: 60_000 });
      const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME '));
      expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined();
      const outcome = JSON.parse((line as string).slice('OUTCOME '.length)) as Record<string, Record<string, string | number>>;
      const live = outcome.live!;
      expect(live.pageWrite).toStartWith("PYRIC_LIVE_REFUSED: @pyric/live: setDoc from a page's pyric runtime is refused in live mode.");
      expect(live.studioWrite).toStartWith('PYRIC_LIVE_REFUSED: @pyric/live: setDoc from Studio is refused in live mode.');
      expect(live.toolWrite).toStartWith('PYRIC_LIVE_REFUSED: @pyric/live: firestore_create_document from an MCP tool is refused in live mode.');
      expect(live.commandWrite).toStartWith('PYRIC_LIVE_REFUSED: @pyric/live: firestore.setDoc from a pyric command is refused in live mode.');
      expect(live.userWrite).toStartWith("PYRIC_LIVE_REFUSED: @pyric/live: auth.adminCreateUser from a page's pyric runtime is refused");
      expect(live.read).toBe('ok');
      expect(live.documents).toBe(0);
      // Without the refusal, the same host makes every one of those writes.
      expect(outcome.sandbox).toEqual({
        pageWrite: 'ok', studioWrite: 'ok', toolWrite: 'ok', commandWrite: 'ok', userWrite: 'ok', read: 'ok', documents: 4,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
