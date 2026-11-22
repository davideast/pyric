/**
 * Dual-plane regression checks for:
 * - #1736: dev server terminal shows the server App Check hint (untruncated)
 *   for remote Node processes across unary and streaming AI requests on both
 *   hosted (`node`/`relay` ports) and SharedWorker planes.
 * - #1656 low 2: worker-plane AI gate rejects cross-project / cross-appId tokens.
 * - #1851: real worker `appCheck.getToken` and `sandbox.clock` stay aligned.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { aiDiagnosticPayloadFor } from '../../src/serve/ai-diagnostics-relay.js';
import { formatAiRejectionBlock } from '../../src/serve/ai-terminal-blocks.js';
import { AI_TERMINAL_HINT_MAX } from '../../src/serve/ai-terminal-text.js';
import { createDenialThrottle, noteAiDiagnostic } from '../../src/serve/namespace.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import { markPortConnection } from '../../src/serve/worker/host/caller.js';
import type { OutboundMessage } from '../../src/serve/worker/protocol.js';

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    postMessage: (message) => {
      messages.push(message);
    },
  };
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  sandboxes.push(sandbox);
  return { db: getFirestore(sandbox), sandbox, subs: new Map() };
}

const sandboxes: Array<ReturnType<typeof initializeSandbox>> = [];
afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    if (sb !== undefined) sb.dispose();
  }
});

const MODEL = 'models/gemini-flash-lite-latest';
const REQUEST = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

function collectTerminalNotes(ctx: HostCtx): string[] {
  const notes: string[] = [];
  const throttle = createDenialThrottle();
  const logger = { info: () => {}, note: (line: string) => notes.push(line) };
  ctx.sandbox.onEvent((event) => {
    const payload = aiDiagnosticPayloadFor(event);
    if (payload !== null) noteAiDiagnostic(throttle, logger, payload);
  });
  return notes;
}

describe('#1736: dev server terminal shows server App Check hint for remote Node process', () => {
  it('prints the full server hint without truncation for a Node host port on unary AI ops', async () => {
    const ctx = makeCtx();
    const notes = collectTerminalNotes(ctx);
    const nodePort = fakePort();
    markPortConnection(ctx, nodePort, 'node');

    await handleMessage(ctx, nodePort, {
      t: 'op',
      id: 'node-unary-1',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null },
    });

    expect(notes).toHaveLength(1);
    const block = notes[0] ?? '';
    expect(block).toContain('CustomProvider');
    expect(block).toContain('globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true');
    expect(block).toContain('getAppCheck().createToken(appId)');
    expect(block).toContain('https://firebase.google.com/docs/ai-logic/app-check');
    expect(block).not.toContain('self.FIREBASE_APPCHECK_DEBUG_TOKEN');
    expect(block.trimEnd().endsWith('\u2026')).toBe(false);
  });

  it('prints the full server hint for a relayed port on streaming AI subscriptions', async () => {
    const ctx = makeCtx();
    const notes = collectTerminalNotes(ctx);
    const relayPort = fakePort();
    markPortConnection(ctx, relayPort, 'relay');

    await handleMessage(ctx, relayPort, {
      t: 'sub',
      subId: 'sub-relay-1',
      target: { service: 'ai', op: 'streamGenerateContent' },
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null },
    });
    // Wait for the detached async subscription gate to reject.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(notes).toHaveLength(1);
    const block = notes[0] ?? '';
    expect(block).toContain('globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true');
    expect(block).toContain('getAppCheck().createToken(appId)');
    expect(block).not.toContain('self.FIREBASE_APPCHECK_DEBUG_TOKEN');
    expect(block.trimEnd().endsWith('\u2026')).toBe(false);
  });

  it('honors explicit appCheck.runtime across planes and does not let browser throttle hide server hints', async () => {
    const ctx = makeCtx();
    const notes = collectTerminalNotes(ctx);
    const pagePort = fakePort();

    await handleMessage(ctx, pagePort, {
      t: 'op',
      id: 'browser-1',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null, runtime: 'browser' },
    });
    // Second identical refusal on the same model stays throttled.
    await handleMessage(ctx, pagePort, {
      t: 'op',
      id: 'browser-2',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null, runtime: 'browser' },
    });
    // A server refusal on the same model carries a different hint, so both print once.
    await handleMessage(ctx, pagePort, {
      t: 'op',
      id: 'server-1',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null, runtime: 'server' },
    });
    await handleMessage(ctx, pagePort, {
      t: 'op',
      id: 'server-2',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null, runtime: 'server' },
    });

    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('self.FIREBASE_APPCHECK_DEBUG_TOKEN = true');
    expect(notes[1]).toContain('globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true');
  });

  it('rejects invalid appCheck.runtime values in inbound worker validation', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-runtime',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: { token: null, runtime: 'desktop' as 'browser' },
    });
    expect(port.messages).toHaveLength(1);
    const res = port.messages[0] as { ok?: boolean; error?: { message?: string } };
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain('appCheck.runtime');
  });

  it('still caps oversized remote hint payloads at AI_TERMINAL_HINT_MAX', () => {
    const block = formatAiRejectionBlock({
      kind: 'ai-rejection',
      model: MODEL,
      message: 'refused',
      hint: 'h'.repeat(AI_TERMINAL_HINT_MAX + 500),
    });
    const lastLine = block.split('\n').at(-1) ?? '';
    expect(lastLine.endsWith('\u2026')).toBe(true);
    expect(lastLine.trim().length).toBe(AI_TERMINAL_HINT_MAX + 1);
  });
});

describe('#1656 / #1851: worker plane audience enforcement and virtual clock parity', () => {
  it('refuses cross-project and cross-appId tokens forwarded over the worker protocol', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const wrongProject = await mintAppCheckToken(
      { appId: '1:123:web:app1', projectId: 'project-other' },
      3600,
    );
    const matching = await mintAppCheckToken(
      { appId: '1:123:web:app1', projectId: 'project-target' },
      3600,
    );

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-aud',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: {
        token: wrongProject.token,
        runtime: 'browser',
        projectId: 'project-target',
        appId: '1:123:web:app1',
      },
    });
    const denied = port.messages.pop() as { ok: boolean; error?: { aiEnvelope?: { error: { code: number } } } };
    expect(denied.ok).toBe(false);
    expect(denied.error?.aiEnvelope?.error.code).toBe(401);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'good-aud',
      method: 'ai.generateContent',
      model: MODEL,
      request: REQUEST,
      appCheck: {
        token: matching.token,
        runtime: 'browser',
        projectId: 'project-target',
        appId: '1:123:web:app1',
      },
    });
    const accepted = port.messages.pop() as { ok: boolean };
    expect(accepted.ok).toBe(true);
  });

  it('mints and caches worker appCheck.getToken timestamps using sandbox clock', async () => {
    const ctx = makeCtx();
    const clock = getClock(ctx.sandbox);
    const fixed = Date.UTC(2026, 0, 10, 0, 0, 0);
    clock.set(fixed);
    const port = fakePort();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 't1',
      method: 'appCheck.getToken',
      projectId: 'proj-clock',
      appId: '1:111:web:abc',
    });
    const r1 = port.messages.pop() as { ok: boolean; value: { token: string; expireTimeMillis: number } };
    expect(r1.ok).toBe(true);
    expect(r1.value.expireTimeMillis).toBe(fixed + 3600 * 1000);

    // Advance past expiry -> fresh token minted at the new clock time.
    clock.advance(3601 * 1000);
    await handleMessage(ctx, port, {
      t: 'op',
      id: 't2',
      method: 'appCheck.getToken',
      projectId: 'proj-clock',
      appId: '1:111:web:abc',
    });
    const r2 = port.messages.pop() as { ok: boolean; value: { token: string; expireTimeMillis: number } };
    expect(r2.ok).toBe(true);
    expect(r2.value.token).not.toBe(r1.value.token);
    expect(r2.value.expireTimeMillis).toBe(fixed + 3601 * 1000 + 3600 * 1000);
  });
});
