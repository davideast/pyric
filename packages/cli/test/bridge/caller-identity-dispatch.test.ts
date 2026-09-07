/**
 * The caller identity `auth_impersonate` records governs the tool calls the
 * caller then forwards.
 *
 * Three layers, because the identity crosses three seams before it reaches a
 * rules evaluation:
 *
 *   1. `dispatchSandbox` puts it on the `tool-call` frame — and omits it for
 *      the default `app-session`, so an un-impersonated call is byte-identical
 *      to the frame the bridge has always sent.
 *   2. `buildSandboxDispatcher` binds the Firestore handle to it, with a
 *      call's own `as` argument still winning.
 *   3. The SharedWorker host relays it from the `tool` frame into that same
 *      dispatcher, which is the path a served page actually takes.
 */
import { describe, it, expect } from 'bun:test';
import { createBridge } from '../../src/bridge/server/bridge.js';
import type { BridgeMessage, ToolCallRequest } from '../../src/bridge/protocol.js';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { OutboundMessage, ResMessage } from '../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

/**
 * Zones that tell the identities apart: `notes` needs the owner's uid,
 * `open` needs a genuinely absent auth, `sealed` needs the rules bypass,
 * `claimed` needs a custom claim, and `tenanted` needs the tenant.
 */
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{note} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
    }
    match /open/{doc} {
      allow read: if request.auth == null;
    }
    match /sealed/{doc} {
      allow read: if false;
    }
    match /claimed/{doc} {
      allow read: if request.auth != null && request.auth.token.role == 'admin';
    }
    match /tenanted/{doc} {
      allow read: if request.auth != null && request.auth.token.firebase.tenant == 'acme';
    }
  }
}`;

async function seededDispatcher() {
  const sandbox = initializeSandbox();
  const dispatch = buildSandboxDispatcher(sandbox);
  // Seed with no identity at all — the historical admin-bypass default.
  for (const [path, data] of [
    ['notes/n1', { owner: 'alice' }],
    ['open/o1', { v: 1 }],
    ['sealed/s1', { v: 1 }],
    ['claimed/c1', { v: 1 }],
    ['tenanted/t1', { v: 1 }],
  ] as const) {
    expect((await dispatch('firestore_create_document', { path, data })).ok).toBe(true);
  }
  setRules(sandbox, RULES);
  return { sandbox, dispatch };
}

describe('the bridge puts the caller identity on the frames it forwards', () => {
  function peerBridge() {
    const frames: BridgeMessage[] = [];
    const bridge = createBridge({ version: 'test' });
    bridge.registerSandboxPeer((msg) => frames.push(msg), ['firestore_get_document'], 'peer-1');
    async function dispatchAndAnswer(): Promise<ToolCallRequest> {
      const pending = bridge.dispatch('firestore_get_document', { path: 'notes/n1' });
      const frame = frames.at(-1) as ToolCallRequest;
      bridge.handleSandboxMessage({
        type: 'tool-result',
        id: frame.id,
        ok: true,
        result: { ok: true, summary: 'ok' },
      });
      await pending;
      return frame;
    }
    return { bridge, dispatchAndAnswer };
  }

  it('sends no identity at all while the caller holds the app session', async () => {
    const { bridge, dispatchAndAnswer } = peerBridge();
    expect(bridge.callerIdentity.get()).toEqual({ mode: 'app-session' });

    const frame = await dispatchAndAnswer();
    expect(Object.keys(frame).sort()).toEqual(['args', 'id', 'name', 'type']);
    expect('actAs' in frame).toBe(false);
  });

  it('sends the recorded identity, and stops once it is reset', async () => {
    const { bridge, dispatchAndAnswer } = peerBridge();

    bridge.callerIdentity.set({ mode: 'as', uid: 'alice', tenant: 'acme', token: { role: 'admin' } });
    expect((await dispatchAndAnswer()).actAs).toEqual({
      mode: 'as',
      uid: 'alice',
      tenant: 'acme',
      token: { role: 'admin' },
    });

    bridge.callerIdentity.set({ mode: 'admin' });
    expect((await dispatchAndAnswer()).actAs).toEqual({ mode: 'admin' });

    bridge.callerIdentity.set({ mode: 'anon' });
    expect((await dispatchAndAnswer()).actAs).toEqual({ mode: 'anon' });

    bridge.callerIdentity.set({ mode: 'app-session' });
    expect('actAs' in (await dispatchAndAnswer())).toBe(false);
  });
});

describe('the tool dispatcher runs a call under the caller identity', () => {
  it('leaves an absent identity, and the app session, exactly as they were', async () => {
    const { dispatch } = await seededDispatcher();

    // Both are the admin-bypass default: a deny-all zone still reads.
    expect((await dispatch('firestore_get_document', { path: 'sealed/s1' })).ok).toBe(true);
    expect(
      (await dispatch('firestore_get_document', { path: 'sealed/s1' }, { mode: 'app-session' })).ok,
    ).toBe(true);
  });

  it('denies the read the identity may not make, and allows it for the owner', async () => {
    const { dispatch } = await seededDispatcher();

    await expect(
      dispatch('firestore_get_document', { path: 'notes/n1' }, { mode: 'as', uid: 'bob' }),
    ).rejects.toThrow();

    const allowed = await dispatch(
      'firestore_get_document',
      { path: 'notes/n1' },
      { mode: 'as', uid: 'alice' },
    );
    expect(allowed.ok).toBe(true);
    expect((allowed.data as { data: unknown }).data).toEqual({ owner: 'alice' });
  });

  it('carries the identity claims and tenant into rules evaluation', async () => {
    const { dispatch } = await seededDispatcher();

    expect(
      (await dispatch('firestore_get_document', { path: 'claimed/c1' }, {
        mode: 'as',
        uid: 'x',
        token: { role: 'admin' },
      })).ok,
    ).toBe(true);
    await expect(
      dispatch('firestore_get_document', { path: 'claimed/c1' }, { mode: 'as', uid: 'x' }),
    ).rejects.toThrow();

    expect(
      (await dispatch('firestore_get_document', { path: 'tenanted/t1' }, {
        mode: 'as',
        uid: 'x',
        tenant: 'acme',
      })).ok,
    ).toBe(true);
    await expect(
      dispatch('firestore_get_document', { path: 'tenanted/t1' }, { mode: 'as', uid: 'x', tenant: 'other' }),
    ).rejects.toThrow();
  });

  it("lets a call's own as argument outrank the identity, in both directions", async () => {
    const { dispatch } = await seededDispatcher();

    // The identity would be denied; the argument is allowed.
    expect(
      (await dispatch(
        'firestore_get_document',
        { path: 'notes/n1', as: { uid: 'alice' } },
        { mode: 'as', uid: 'bob' },
      )).ok,
    ).toBe(true);

    // The identity would be allowed; the argument is denied.
    await expect(
      dispatch(
        'firestore_get_document',
        { path: 'notes/n1', as: { uid: 'bob' } },
        { mode: 'as', uid: 'alice' },
      ),
    ).rejects.toThrow();

    // The argument may also name the bypass while the identity is a user.
    expect(
      (await dispatch(
        'firestore_get_document',
        { path: 'sealed/s1', as: 'admin' },
        { mode: 'as', uid: 'bob' },
      )).ok,
    ).toBe(true);
  });

  it('bypasses rules for admin and runs genuinely signed out for anonymous', async () => {
    const { dispatch } = await seededDispatcher();

    expect(
      (await dispatch('firestore_get_document', { path: 'sealed/s1' }, { mode: 'admin' })).ok,
    ).toBe(true);

    // Anonymous is not "some user" and not the bypass: the anon-only zone
    // reads, the signed-in zone and the sealed zone do not.
    expect(
      (await dispatch('firestore_get_document', { path: 'open/o1' }, { mode: 'anon' })).ok,
    ).toBe(true);
    await expect(
      dispatch('firestore_get_document', { path: 'notes/n1' }, { mode: 'anon' }),
    ).rejects.toThrow();
    await expect(
      dispatch('firestore_get_document', { path: 'sealed/s1' }, { mode: 'anon' }),
    ).rejects.toThrow();
  });

  it('never lets an identity change which tools exist', async () => {
    const { dispatch } = await seededDispatcher();
    await expect(
      dispatch('firestore_no_such_tool', {}, { mode: 'as', uid: 'alice' }),
    ).rejects.toThrow('unknown sandbox tool');
  });
});

describe('the SharedWorker host relays the identity into the same dispatcher', () => {
  function fakePort(): PortLike & { messages: OutboundMessage[] } {
    const messages: OutboundMessage[] = [];
    return { messages, postMessage: (msg) => void messages.push(msg) };
  }

  async function tool(
    ctx: HostCtx,
    port: ReturnType<typeof fakePort>,
    args: Record<string, unknown>,
    actAs?: { mode: 'admin' } | { mode: 'anon' } | { mode: 'app-session' } | { mode: 'as'; uid: string },
  ): Promise<ResMessage> {
    const id = `tool-${port.messages.length}`;
    await handleMessage(ctx, port, {
      t: 'tool',
      id,
      name: 'firestore_get_document',
      args,
      ...(actAs ? { actAs } : {}),
    });
    return port.messages.find(
      (msg): msg is ResMessage => msg.t === 'res' && msg.id === id,
    )!;
  }

  it('rules-evaluates a forwarded tool call as the identity on the tool frame', async () => {
    const sandbox = initializeSandbox();
    // The host best-effort flushes after every acked write; give it a backend
    // so the seeds below don't log a failed-precondition for every document.
    await sandbox.enablePersistence({
      key: `caller-identity-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'caller-identity-test',
      subs: new Map(),
      sessionMode: 'LOCAL',
    };
    const port = fakePort();

    // Seed through the same worker path, with no identity: still admin.
    for (const [path, data] of [
      ['notes/n1', { owner: 'alice' }],
      ['sealed/s1', { v: 1 }],
    ] as const) {
      await handleMessage(ctx, port, {
        t: 'tool',
        id: `seed-${path}`,
        name: 'firestore_create_document',
        args: { path, data },
      });
    }
    setRules(sandbox, RULES);

    expect((await tool(ctx, port, { path: 'notes/n1' }, { mode: 'as', uid: 'bob' })).ok).toBe(false);
    expect((await tool(ctx, port, { path: 'notes/n1' }, { mode: 'as', uid: 'alice' })).ok).toBe(true);
    expect((await tool(ctx, port, { path: 'sealed/s1' }, { mode: 'admin' })).ok).toBe(true);
    // No identity on the frame keeps the historical admin behaviour.
    expect((await tool(ctx, port, { path: 'sealed/s1' })).ok).toBe(true);
    expect((await tool(ctx, port, { path: 'sealed/s1' }, { mode: 'app-session' })).ok).toBe(true);
    // The per-call argument still wins over the frame's identity.
    expect(
      (await tool(ctx, port, { path: 'notes/n1', as: { uid: 'alice' } }, { mode: 'as', uid: 'bob' })).ok,
    ).toBe(true);
  });
});
