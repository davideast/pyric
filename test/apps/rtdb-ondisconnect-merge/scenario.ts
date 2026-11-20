// Verifies that sequential RTDB onDisconnect() registrations at one path merge
// across hosted Node clients fired both by goOffline() and by process exit.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

interface ClientPayload {
  readonly sentinel: unknown;
  readonly results: Record<string, unknown>;
}

const EXPECTED: Record<string, unknown> = {
  'update-then-update-other-child': { a: 1, b: 2, keep: true },
  'update-then-update-same-child': { a: 2, keep: true },
  'update-then-update-deep-keys': { i1: { state: 'gone' }, i2: { state: 'gone' }, keep: true },
  'update-then-update-at-child-path': { keep: true, x: { a: 1, b: 2 } },
  'update-then-set': { b: 2 },
  'set-then-update': { a: 1, b: 2 },
  'update-then-remove': null,
  'two-updates-then-cancel-path': { keep: true },
  'two-updates-then-cancel-one-child': { b: 2, keep: true },
  'update-object-then-deep-child': { a: { x: 1, y: 3 }, keep: true },
  'remove-then-update': { b: 2 },
  'parent-update-child-set-parent-deep-update': { keep: true, other: 1, sub: { x: 9, y: 1 } },
  'set-inline-priority-atomic-delete-and-add': { '.priority': 9, b: 2 },
  'parent-set-child-set-parent-update-child-cancel': { a: { b: 2, old: 1 }, keep: true },
};

function parsePayload(output: string): ClientPayload {
  const match = output.match(/^RESULT (.*)$/m);
  assert.ok(match, `expected RESULT line in:\n${output}`);
  const raw = match[1];
  assert.ok(raw !== undefined, `expected RESULT payload in:\n${output}`);
  return JSON.parse(raw) as ClientPayload;
}

async function waitForExitDrain(app: App, hostUrl: string, root: string): Promise<ClientPayload> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { output } = await app.serverScript('client.mjs', ['read', root], {
      env: { PYRIC_SANDBOX: `remote:${hostUrl}` },
    });
    const payload = parsePayload(output);
    if (payload.sentinel === 'drained') return payload;
    assert.ok(Date.now() < deadline, `onDisconnect did not drain on process exit:\n${output}`);
    await sleep(150);
  }
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const offline = await app.step('register sequences and fire via goOffline()', async () => {
    const { output } = await app.serverScript('client.mjs', ['offline', 'offline'], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
    });
    return parsePayload(output);
  });

  await app.step('assert goOffline() results match server merge semantics', () => {
    assert.equal(offline.sentinel, 'drained');
    assert.deepEqual(offline.results, EXPECTED);
  });

  await app.step('register sequences and exit the client process', () =>
    app.serverScript('client.mjs', ['register-and-exit', 'exit'], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
    }));

  const onExit = await app.step('read results after the host drains on socket close', () =>
    waitForExitDrain(app, host.url, 'exit'));

  await app.step('assert process exit results match server merge semantics', () => {
    assert.deepEqual(onExit.results, EXPECTED);
  });

  const denied = await app.step('register auth-gated onDisconnect, sign out, and goOffline()', async () => {
    const { output } = await app.serverScript('client.mjs', ['denied-after-signout', 'guarded'], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
    });
    const match = output.match(/^RESULT (.*)$/m);
    const payload = match?.[1];
    assert.ok(payload !== undefined, `expected RESULT line in:\n${output}`);
    return JSON.parse(payload) as { sentinel: unknown; added: string[]; stored: unknown };
  });

  await app.step('assert denied onDisconnect drain emits no speculative child_added events', () => {
    assert.equal(denied.sentinel, 'drained');
    assert.deepEqual(denied.added, []);
    assert.equal(denied.stored, null);
  });
});
