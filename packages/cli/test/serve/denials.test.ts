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
import { createDenialThrottle, createPyricNamespace, formatDenialBlock } from '../../src/serve/namespace.js';
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

  it('falls back to "anonymous" auth and omits missing fields', () => {
    const block = formatDenialBlock({ message: 'denied', denialContext: { auth: null } });
    expect(block).toContain('anonymous');
    expect(block.split('\n').length).toBe(2); // message + auth only
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
