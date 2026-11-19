import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
} from '../../../src/serve/worker/protocol.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
);

function loadBehavior(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return raw.behavior;
}

function createFakePort(): PortLike & { messages: OutboundMessage[]; snaps: SnapMessage[] } {
  const messages: OutboundMessage[] = [];
  const snaps: SnapMessage[] = [];
  return {
    messages,
    snaps,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') {
        snaps.push(msg);
      }
    },
  };
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'test-ai-edges', subs: new Map() };
}

async function sendOp(
  ctx: HostCtx,
  port: ReturnType<typeof createFakePort>,
  msg: InboundMessage,
): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  const id = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (res === undefined) {
    throw new Error(`No res message for ${id}`);
  }
  return res;
}

describe('worker host AI request-edge parity (AI-21, AI-22, AI-23)', () => {
  it('accepts roleless contents across ai.generateContent and ai.countTokens (AI-21)', async () => {
    const facts = loadBehavior('ai-request-edge-roleless-contents');
    const ctx = makeCtx();
    try {
      const port = createFakePort();
      const request = { contents: [{ parts: [{ text: 'Reply with one word: pong' }] }] };
      const genRes = await sendOp(ctx, port, {
        t: 'op',
        id: 'edge-roleless-gen',
        method: 'ai.generateContent',
        model: 'models/gemini-flash-lite-latest',
        request,
      });
      expect(genRes.ok).toBe(true);
      const value = (genRes as ResMessage & { ok: true }).value as {
        candidates?: Array<{ finishReason?: string; content?: { role?: string } }>;
      };
      expect(value.candidates?.[0]?.finishReason).toBe(facts.finishReason);
      expect(value.candidates?.[0]?.content?.role).toBe(facts.contentRole);

      const countRes = await sendOp(ctx, port, {
        t: 'op',
        id: 'edge-roleless-count',
        method: 'ai.countTokens',
        model: 'models/gemini-flash-lite-latest',
        request,
      });
      expect(countRes.ok).toBe(true);
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('rejects raw wire string systemInstruction with 400 INVALID_ARGUMENT and BadRequest details (AI-22)', async () => {
    const facts = loadBehavior('ai-request-edge-string-system-instruction');
    const ctx = makeCtx();
    try {
      const port = createFakePort();
      const res = await sendOp(ctx, port, {
        t: 'op',
        id: 'edge-string-sys',
        method: 'ai.generateContent',
        model: 'models/gemini-flash-lite-latest',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Reply with one word: pong' }] }],
          systemInstruction: 'Answer in lowercase.',
        },
      });
      expect(res.ok).toBe(false);
      const error = (res as ResMessage & { ok: false }).error;
      expect(error.code).toBe('ai/INVALID_ARGUMENT');
      expect(error.aiEnvelope).toEqual(facts.raw);
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('enforces App Check 401 before model lookup and rejects gemini-pro with 404 NOT_FOUND + request_rejected event (AI-23)', async () => {
    const facts = loadBehavior('ai-request-edge-model-gemini-pro');
    const ctx = makeCtx();
    const rejected: Array<Record<string, unknown>> = [];
    const stop = ctx.sandbox.onEvent((event) => {
      if (event.kind === 'service_mutation' && event.service === 'ai' && event.op === 'request_rejected') {
        rejected.push(event.detail);
      }
    });
    try {
      const port = createFakePort();
      const request = { contents: [{ role: 'user', parts: [{ text: 'Reply with one word: pong' }] }] };

      // Missing App Check token refuses 401 UNAUTHENTICATED before model lookup.
      const unauthRes = await sendOp(ctx, port, {
        t: 'op',
        id: 'edge-gemini-pro-unauth',
        method: 'ai.generateContent',
        model: 'models/gemini-pro',
        request,
        appCheck: { token: null },
      });
      expect(unauthRes.ok).toBe(false);
      expect((unauthRes as ResMessage & { ok: false }).error.code).toBe('ai/UNAUTHENTICATED');

      // Valid App Check token reaches model routing, rejects 404 NOT_FOUND, and emits request_rejected.
      const validClaim = await mintAppCheckToken(
        { appId: '1:123456789012:web:abcdef', projectId: 'sandbox' },
        3600,
      );
      const authedRes = await sendOp(ctx, port, {
        t: 'op',
        id: 'edge-gemini-pro-authed',
        method: 'ai.generateContent',
        model: 'models/gemini-pro',
        request,
        appCheck: { token: validClaim.token },
      });
      expect(authedRes.ok).toBe(false);
      const authedErr = (authedRes as ResMessage & { ok: false }).error;
      expect(authedErr.code).toBe('ai/NOT_FOUND');
      expect(authedErr.aiEnvelope).toEqual(facts.raw);
      expect(rejected).toContainEqual(
        expect.objectContaining({
          code: 404,
          status: 'NOT_FOUND',
          message: facts.messageText,
        }),
      );
    } finally {
      stop();
      ctx.sandbox.dispose();
    }
  });
});
