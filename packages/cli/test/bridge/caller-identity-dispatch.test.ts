/**
 * The caller identity governs the tool calls the caller forwards across all 3 layers.
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
  for (const [path, data] of [
    ['notes/n1', { owner: 'alice' }],
    ['open/o1', { v: 1 }],
    ['sealed/s1', { v: 1 }],
    ['claimed/c1', { v: 1 }],
    ['tenanted/t1', { v: 1 }],
  ] as const) {
    expect(
      (
        await dispatch('mutate_sandbox_data', {
          service: 'firestore',
          action: 'set',
          path,
          dataJson: JSON.stringify(data),
        })
      ).ok
    ).toBe(true);
  }
  setRules(sandbox, RULES);
  return { sandbox, dispatch };
}

describe('the bridge puts the caller identity on the frames it forwards', () => {
  function peerBridge() {
    const frames: BridgeMessage[] = [];
    const bridge = createBridge({ version: 'test' });
    bridge.registerSandboxPeer((msg) => frames.push(msg), ['query_sandbox_data'], 'peer-1');
    async function dispatchAndAnswer(): Promise<ToolCallRequest> {
      const pending = bridge.dispatch('query_sandbox_data', { service: 'firestore', path: 'notes/n1' });
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

    expect((await dispatch('query_sandbox_data', { service: 'firestore', path: 'sealed/s1' })).ok).toBe(true);
    expect(
      (await dispatch('query_sandbox_data', { service: 'firestore', path: 'sealed/s1' }, { mode: 'app-session' })).ok
    ).toBe(true);
  });

  it('denies the read the identity may not make, and allows it for the owner', async () => {
    const { dispatch } = await seededDispatcher();

    const denied = await dispatch(
      'query_sandbox_data',
      { service: 'firestore', path: 'notes/n1' },
      { mode: 'as', uid: 'bob' }
    );
    expect(denied.ok).toBe(false);

    const allowed = await dispatch(
      'query_sandbox_data',
      { service: 'firestore', path: 'notes/n1' },
      { mode: 'as', uid: 'alice' }
    );
    expect(allowed.ok).toBe(true);
    expect((allowed.data as { results: Array<{ data: unknown }> }).results[0].data).toEqual({ owner: 'alice' });
  });

  it('carries the identity claims and tenant into rules evaluation', async () => {
    const { dispatch } = await seededDispatcher();

    expect(
      (
        await dispatch('query_sandbox_data', { service: 'firestore', path: 'claimed/c1' }, {
          mode: 'as',
          uid: 'x',
          token: { role: 'admin' },
        })
      ).ok
    ).toBe(true);
    expect(
      (await dispatch('query_sandbox_data', { service: 'firestore', path: 'claimed/c1' }, { mode: 'as', uid: 'x' })).ok
    ).toBe(false);

    expect(
      (
        await dispatch('query_sandbox_data', { service: 'firestore', path: 'tenanted/t1' }, {
          mode: 'as',
          uid: 'x',
          tenant: 'acme',
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await dispatch('query_sandbox_data', { service: 'firestore', path: 'tenanted/t1' }, {
          mode: 'as',
          uid: 'x',
          tenant: 'other',
        })
      ).ok
    ).toBe(false);
  });

  it("lets a call's own auth argument outrank the identity, in both directions", async () => {
    const { dispatch } = await seededDispatcher();

    // The identity would be denied; the argument is allowed.
    expect(
      (
        await dispatch(
          'query_sandbox_data',
          { service: 'firestore', path: 'notes/n1', auth: { mode: 'uid', uid: 'alice' } },
          { mode: 'as', uid: 'bob' }
        )
      ).ok
    ).toBe(true);

    // The identity would be allowed; the argument is denied.
    expect(
      (
        await dispatch(
          'query_sandbox_data',
          { service: 'firestore', path: 'notes/n1', auth: { mode: 'uid', uid: 'bob' } },
          { mode: 'as', uid: 'alice' }
        )
      ).ok
    ).toBe(false);

    // The argument may also name the bypass while the identity is a user.
    expect(
      (
        await dispatch(
          'query_sandbox_data',
          { service: 'firestore', path: 'sealed/s1', auth: { mode: 'admin' } },
          { mode: 'as', uid: 'bob' }
        )
      ).ok
    ).toBe(true);
  });

  it('bypasses rules for admin and runs genuinely signed out for anonymous', async () => {
    const { dispatch } = await seededDispatcher();

    expect(
      (await dispatch('query_sandbox_data', { service: 'firestore', path: 'sealed/s1' }, { mode: 'admin' })).ok
    ).toBe(true);

    expect(
      (await dispatch('query_sandbox_data', { service: 'firestore', path: 'open/o1' }, { mode: 'anon' })).ok
    ).toBe(true);
    expect(
      (await dispatch('query_sandbox_data', { service: 'firestore', path: 'notes/n1' }, { mode: 'anon' })).ok
    ).toBe(false);
    expect(
      (await dispatch('query_sandbox_data', { service: 'firestore', path: 'sealed/s1' }, { mode: 'anon' })).ok
    ).toBe(false);
  });

  it('never lets an identity change which tools exist', async () => {
    const { dispatch } = await seededDispatcher();
    await expect(
      dispatch('firestore_no_such_tool', {}, { mode: 'as', uid: 'alice' })
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
    actAs?: { mode: 'admin' } | { mode: 'anon' } | { mode: 'app-session' } | { mode: 'as'; uid: string }
  ): Promise<ResMessage> {
    const id = `tool-${port.messages.length}`;
    await handleMessage(ctx, port, {
      t: 'tool',
      id,
      name: 'query_sandbox_data',
      args: { service: 'firestore', ...args },
      ...(actAs ? { actAs } : {}),
    });
    return port.messages.find(
      (msg): msg is ResMessage => msg.t === 'res' && msg.id === id
    )!;
  }

  it('rules-evaluates a forwarded tool call as the identity on the tool frame', async () => {
    const sandbox = initializeSandbox();
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

    for (const [path, data] of [
      ['notes/n1', { owner: 'alice' }],
      ['sealed/s1', { v: 1 }],
    ] as const) {
      await handleMessage(ctx, port, {
        t: 'tool',
        id: `seed-${path}`,
        name: 'mutate_sandbox_data',
        args: { service: 'firestore', action: 'set', path, dataJson: JSON.stringify(data) },
      });
    }
    setRules(sandbox, RULES);

    expect((await tool(ctx, port, { path: 'notes/n1' }, { mode: 'as', uid: 'bob' })).ok).toBe(false);
    expect((await tool(ctx, port, { path: 'notes/n1' }, { mode: 'as', uid: 'alice' })).ok).toBe(true);
    expect((await tool(ctx, port, { path: 'sealed/s1' }, { mode: 'admin' })).ok).toBe(true);
  });
});
