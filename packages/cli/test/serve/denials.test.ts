/**
 * `/__pyric/denials` — the headless-dev visibility relay. The worker client
 * fire-and-forget POSTs a rules denial here; the dev server prints a
 * compact block to the terminal (via the wired `ServeLogger`) so an agent
 * driving `pyric dev` without a browser sees it too.
 *
 *   - POST prints once via `logger.note`, throttled per (path, message)
 *   - a second POST for the SAME (path, message) within the window is
 *     suppressed silently (no output at all)
 *   - a different message/path always prints
 *   - GET is rejected with 405
 *   - always 204s, even for a malformed body
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDenialThrottle, createPyricNamespace, DENIAL_BODY_LIMIT_BYTES, formatDenialBlock } from '../../src/serve/namespace.js';
import { startStaticServer, type ServeHandle, type ServeLogger } from '../../src/serve/server.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-denials-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return { site, sdk };
}

function recordingLogger(): { logger: ServeLogger; notes: string[] } {
  const notes: string[] = [];
  return { logger: { info: () => {}, note: (m) => notes.push(m) }, notes };
}

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

async function startServe(logger: ServeLogger): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    logger,
  });
  const h = await startStaticServer({
    publicDir: site,
    port: 0,
    host: '127.0.0.1',
    portScanLimit: 200,
    logger,
    namespaceHandler: ns,
  });
  handles.push(h);
  return h;
}

const denialBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'read',
  code: 'permission-denied',
  message: 'get tickets/T-1 denied by rules',
  denialContext: {
    auth: { uid: 'user-1' },
    request: { method: 'get', path: 'tickets/T-1' },
    reasons: ['Rule #0 → deny'],
  },
  ...overrides,
});

describe('/__pyric/denials', () => {
  it('prints one line via logger.note for a denial POST', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(denialBody()),
    });
    expect(res.status).toBe(204);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('get tickets/T-1 denied by rules');
    expect(notes[0]).toContain('get tickets/T-1');
    expect(notes[0]).toContain('user-1');
  });

  it('throttles a repeat of the SAME (path, message) — silent, no output', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${h.url}/__pyric/denials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(denialBody()),
      });
      expect(res.status).toBe(204);
    }
    expect(notes.length).toBe(1);
  });

  it('does NOT throttle a different message/path', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(denialBody()),
    });
    await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        denialBody({
          message: 'list tickets denied by rules',
          denialContext: {
            auth: null,
            request: { method: 'list', path: 'tickets' },
          },
        }),
      ),
    });
    expect(notes.length).toBe(2);
    expect(notes[1]).toContain('list tickets denied by rules');
    expect(notes[1]).toContain('anonymous'); // no auth.uid → anonymous
  });

  it('prints the same path denied on two RTDB instances once each within the window', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const onInstance = (instance: string) => denialBody({
      message: 'PERMISSION_DENIED',
      instance,
      denialContext: { engine: 'rtdb', auth: null, request: { method: 'listen', path: '/rooms/r1' } },
    });
    for (const instance of ['demo-app-default-rtdb', 'demo-app-shard-1', 'demo-app-shard-1']) {
      await fetch(`${h.url}/__pyric/denials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(onInstance(instance)),
      });
    }
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('listen /rooms/r1 (demo-app-default-rtdb)');
    expect(notes[1]).toContain('listen /rooms/r1 (demo-app-shard-1)');
  });

  it('rejects non-POST with 405', async () => {
    const { logger } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('204s even for a malformed body (best-effort diagnostics, never fails the page)', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(204);
    expect(notes.length).toBe(0);
  });

  it('refuses a cross-origin POST with 403 and prints nothing', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://localhost:1' },
      body: JSON.stringify(denialBody({ message: 'forged from another page' })),
    });
    expect(res.status).toBe(403);
    expect(notes).toEqual([]);
  });

  it('accepts a POST whose Origin is the page this server serves', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(h.url).origin },
      body: JSON.stringify(denialBody()),
    });
    expect(res.status).toBe(204);
    expect(notes.length).toBe(1);
  });

  it('answers 413 for a body over the limit and prints nothing', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(denialBody({ message: 'x'.repeat(DENIAL_BODY_LIMIT_BYTES) })),
    });
    expect(res.status).toBe(413);
    expect(notes).toEqual([]);
  });

  it('closes the connection with an early 413, so a reused socket cannot read the next request as the unread upload (#1706)', async () => {
    const h = await startServe(recordingLogger().logger);
    const oversized = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(denialBody({ message: 'x'.repeat(1024 * 1024) })),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('connection')).toBe('close');
  });

  it('prints a same-origin denial carrying terminal escapes as one safe block', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(denialBody({ message: 'x\u001b]0;OWNED\u0007\nFAKE pyric line' })),
    });
    expect(res.status).toBe(204);
    expect(notes.length).toBe(1);
    expect(notes[0]).not.toContain('\u001b');
    expect(notes[0]!.split('\n')[0]).toBe('  ⚠ [pyric] denied: x ]0;OWNED FAKE pyric line');
  });

  it('drops output entirely when no logger is wired', async () => {
    const { site, sdk } = fixture();
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: recordingLogger().logger,
      namespaceHandler: ns,
    });
    handles.push(h);
    const res = await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(denialBody()),
    });
    expect(res.status).toBe(204); // no throw despite the namespace having no logger
  });
});

describe('createDenialThrottle', () => {
  it('suppresses a repeat key within the window, allows it again after', () => {
    const throttle = createDenialThrottle(1000);
    expect(throttle.shouldPrint('a', 0)).toBe(true);
    expect(throttle.shouldPrint('a', 500)).toBe(false);
    expect(throttle.shouldPrint('a', 1500)).toBe(true);
  });

  it('tracks keys independently', () => {
    const throttle = createDenialThrottle(1000);
    expect(throttle.shouldPrint('a', 0)).toBe(true);
    expect(throttle.shouldPrint('b', 0)).toBe(true);
  });
});

describe('formatDenialBlock', () => {
  it('names the deciding rule of an RTDB denial', () => {
    const block = formatDenialBlock({
      message: 'PERMISSION_DENIED: Permission denied',
      denialContext: {
        engine: 'rtdb',
        auth: { uid: 'alice' },
        request: { method: 'set', path: '/rooms/bob' },
        matchedPath: '/rooms/$roomId',
        matchedRule: 'auth.uid == $roomId',
      },
    });
    expect(block.split('\n')).toEqual([
      '  ⚠ [pyric] denied: PERMISSION_DENIED: Permission denied',
      '      set /rooms/bob',
      '      auth: alice',
      '      rule: /rooms/$roomId auth.uid == $roomId',
    ]);
  });

  it('names the RTDB instance the denied request addressed', () => {
    const block = formatDenialBlock({
      message: 'PERMISSION_DENIED',
      instance: 'demo-app-shard-1',
      denialContext: { engine: 'rtdb', auth: { uid: 'alice' }, request: { method: 'listen', path: '/rooms/r1' } },
    });
    expect(block.split('\n')[1]).toBe('      listen /rooms/r1 (demo-app-shard-1)');
  });

  it('renders a compact multi-line block: message, request, auth, remediation', () => {
    const block = formatDenialBlock({
      message: 'get tickets/T-1 denied by rules',
      denialContext: {
        auth: { uid: 'user-1' },
        request: { method: 'get', path: 'tickets/T-1' },
        remediation: 'grant read access in firestore.rules',
      },
    });
    const lines = block.split('\n');
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('get tickets/T-1 denied by rules');
    expect(lines[1]).toContain('get tickets/T-1');
    expect(lines[2]).toContain('user-1');
    expect(lines[3]).toContain('grant read access in firestore.rules');
  });

  it('names the code that opened a denied listener and the frames around it', () => {
    const block = formatDenialBlock({
      message: 'PERMISSION_DENIED: Permission denied',
      denialContext: { auth: { uid: 'alice' }, request: { method: 'onValue', path: '/rooms/r1' } },
      owners: [{
        kind: 'frame',
        file: 'http://localhost:5173/src/room-list.js?t=1712',
        line: 5,
        column: 22,
        function: 'listRooms',
        stack: [
          { file: 'http://localhost:5173/src/db.js', line: 5, column: 10, function: 'watch' },
          { file: 'http://localhost:5173/src/room-list.js?t=1712', line: 5, column: 22, function: 'listRooms' },
          { file: 'http://localhost:5173/src/main.js', line: 14, column: 3 },
        ],
      }, { kind: 'tag', name: 'room-list' }],
    });
    expect(block.split('\n')).toEqual([
      '  ⚠ [pyric] denied: PERMISSION_DENIED: Permission denied',
      '      onValue /rooms/r1',
      '      auth: alice',
      '      owner: listRooms /src/room-list.js:5',
      '      stack: /src/db.js:5 ← /src/room-list.js:5 ← /src/main.js:14',
    ]);
  });

  it('names a single-frame owner without a stack line', () => {
    const block = formatDenialBlock({
      message: 'denied',
      denialContext: { auth: null },
      owners: [{ kind: 'frame', file: '/home/me/app/src/room-list.ts', line: 5 }],
    });
    expect(block.split('\n').slice(2)).toEqual(['      owner: /home/me/app/src/room-list.ts:5']);
  });

  it('falls back to "anonymous" auth and omits missing fields', () => {
    const block = formatDenialBlock({ message: 'denied', denialContext: { auth: null } });
    expect(block).toContain('anonymous');
    expect(block.split('\n').length).toBe(2); // message + auth only
  });

  it('flattens control, bidi and newline characters in every page-supplied field', () => {
    const hostile = 'a\u001b[2Jb\r\nFAKE\u202ec';
    const block = formatDenialBlock({
      message: hostile,
      instance: hostile,
      remediation: hostile,
      denialContext: {
        engine: 'rtdb',
        auth: { uid: hostile },
        request: { method: hostile, path: hostile },
        matchedPath: hostile,
        matchedRule: hostile,
      },
      owners: [{ kind: 'frame', file: hostile, line: 1, function: hostile, stack: [
        { file: hostile, line: 1 }, { file: hostile, line: 2 },
      ] }],
    });
    expect(block).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
    // Message, request, auth, rule, two remediation lines, owner, stack.
    const lines = block.split('\n');
    expect(lines.length).toBe(8);
    expect(lines.slice(1).every((line) => line.startsWith('      '))).toBe(true);
  });

  it('keeps a multi-line remediation as indented lines, each sanitized', () => {
    const block = formatDenialBlock({
      message: 'list denied',
      remediation: "Add the matching where(...) constraint:\n  .where('owner', '==', request.auth.uid)\n\u001b[2Jforged",
    });
    expect(block.split('\n').slice(2)).toEqual([
      '      Add the matching where(...) constraint:',
      "        .where('owner', '==', request.auth.uid)",
      '       [2Jforged',
    ]);
  });

  it('prints a query-proof remediation whole, so its command and fixture can be pasted', () => {
    const uid = 'Xq3ZbT9kLmN2pR7sV4wY8aC1dE6f';
    const token = {
      name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true,
      auth_time: 1761600000, iat: 1761600000, exp: 1761603600,
      firebase: { identities: { email: ['ada@example.com'], 'google.com': ['104857600000000000000'] }, sign_in_provider: 'google.com' },
    };
    const query = {
      where: [['status', '==', 'open'], ['team', '==', 'core   platform'], ['archived', '==', false]],
      orderBy: [['createdAt', 'desc']],
      limit: 20,
    };
    const fixture = { description: 'list projects/p1/tasks', expectation: 'ALLOW', method: 'list', path: 'projects/p1/tasks', auth: { uid, token }, query };
    const missing = ['owner', 'org', 'region', 'tier', 'stage', 'lane'].map(
      (field) => `  .where('${field}', '==', request.auth.uid)   // request.auth.uid is "${uid}"`,
    );
    const remediation = [
      'The list rule requires per-document equalities the query does not guarantee. Add the matching where(...) constraint(s) so every returned document satisfies the rule:',
      ...missing,
      '',
      'Reproduce with:',
      `  pyric rules test --method list --path projects/p1/tasks --uid ${uid} --query '${JSON.stringify(query)}'`,
      `  Fixture case: ${JSON.stringify(fixture)}`,
    ];
    expect(remediation.at(-1)!.length).toBeGreaterThan(512);
    const block = formatDenialBlock({
      message: 'list projects/p1/tasks denied: unprovable query',
      remediation: remediation.join('\n'),
      denialContext: { request: { method: 'list', path: 'projects/p1/tasks' }, auth: { uid } },
    });
    const printed = block.split('\n').slice(3);
    expect(printed).toEqual(remediation.map((line) => (line.length > 0 ? `      ${line}` : '')));
    const fixtureLine = printed.at(-1)!.trim();
    expect(JSON.parse(fixtureLine.slice('Fixture case: '.length))).toEqual(fixture);
  });

  it('prefers payload-root remediation (the sandbox error sibling) over the nested fallback', () => {
    const block = formatDenialBlock({
      message: 'list c denied: unprovable query',
      remediation: ".where('ownerUid', '==', request.auth.uid)",
      denialContext: { auth: { uid: 'user-1' }, remediation: 'nested fallback' },
    });
    expect(block).toContain(".where('ownerUid', '==', request.auth.uid)");
    expect(block).not.toContain('nested fallback');
  });
});
