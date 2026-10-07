/**
 * The host's RTDB instances: protocol `instance` routing, per-instance rules
 * through the op and the exported host API, the declared-instances policy,
 * per-instance onDisconnect connections, and reset restoring each instance's
 * rules. The SharedWorker and the Node host run this same dispatch.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAdminDatabase, get, ref } from 'pyric/database';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { drainPortRtdbDisconnects } from '../../../../src/serve/worker/host/rtdb.js';
import {
  RTDB_UNKNOWN_INSTANCE_CODE,
  type InboundMessage,
  type OutboundMessage,
  type ResMessage,
} from '../../../../src/serve/worker/protocol.js';

const OPEN = { rules: { '.read': true, '.write': true } };

function makeCtx(projectId?: string): HostCtx {
  const defaultName = projectId === undefined ? {} : { defaultRtdbInstance: `${projectId}-default-rtdb` };
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'rtdb-instances', subs: new Map(), ...defaultName };
}

/** A port that routes each reply to the operation that asked for it. */
function makePort(): PortLike & { pending: Map<string, (reply: ResMessage) => void> } {
  const pending = new Map<string, (reply: ResMessage) => void>();
  return {
    pending,
    postMessage(reply: OutboundMessage) {
      if (reply.t === 'res') pending.get(reply.id)?.(reply);
    },
  };
}

const sharedPort = makePort();
let sequence = 0;
function send(ctx: HostCtx, message: Record<string, unknown>, port = sharedPort): Promise<ResMessage> {
  return new Promise((resolve) => {
    const id = `op-${++sequence}`;
    port.pending.set(id, resolve);
    void handleMessage(ctx, port, { t: 'op', id, ...message } as InboundMessage);
  });
}

async function value(ctx: HostCtx, instance: string | undefined, path: string): Promise<unknown> {
  const reply = await send(ctx, { method: 'rtdb.get', path, actAs: { mode: 'admin' }, ...(instance ? { instance } : {}) });
  if (!reply.ok) throw new Error(reply.error.message);
  return (reply.value as { value: unknown }).value;
}

describe('host RTDB instances', () => {
  it('deploys the setDatabaseRules op to the instance it names', async () => {
    const ctx = makeCtx();
    const deployed = await send(ctx, { method: 'setDatabaseRules', instance: 'first', source: OPEN });
    expect(deployed).toMatchObject({ ok: true, value: { ok: true } });
    expect((await send(ctx, { method: 'rtdb.set', instance: 'first', path: 'a', value: 1 })).ok).toBe(true);
    const denied = await send(ctx, { method: 'rtdb.set', instance: 'second', path: 'a', value: 1 });
    expect(denied.ok).toBe(false);
    expect(await value(ctx, 'first', 'a')).toBe(1);
    expect(await value(ctx, undefined, 'a')).toBeNull();
    const status = await send(ctx, { method: 'getRulesStatus', service: 'database', instance: 'first' });
    expect(status).toMatchObject({ ok: true, value: { status: 'active', source: OPEN } });
    expect(await send(ctx, { method: 'getRulesStatus', service: 'database', instance: 'second' }))
      .toMatchObject({ ok: true, value: null });
  });

  it('resolves the project default instance name to the default instance', async () => {
    const ctx = makeCtx('host-project');
    setDatabaseRules(ctx, 'host-project-default-rtdb', OPEN);
    await send(ctx, { method: 'rtdb.set', path: 'shared', value: 'by default' });
    expect(await value(ctx, 'host-project-default-rtdb', 'shared')).toBe('by default');
    expect((await get(ref(getAdminDatabase(ctx.sandbox), 'shared'))).val()).toBe('by default');
    expect([...ctx.rtdbInstances!.entries()].map(([key]) => key)).toEqual(['host-project-default-rtdb']);
  });

  it('refuses an invalid instance name with the SDK error', async () => {
    const ctx = makeCtx();
    expect(() => setDatabaseRules(ctx, 'not_valid', OPEN)).toThrow('Cannot parse Firebase url');
    const reply = await send(ctx, { method: 'rtdb.get', instance: 'not.valid', path: 'a' });
    expect(reply.ok).toBe(false);
  });

  it('serves only declared instances, and always the default instance', async () => {
    const ctx = makeCtx('declared-project');
    ctx.declaredRtdbInstances = new Set(['first']);
    setDatabaseRules(ctx, 'first', OPEN);
    setDatabaseRules(ctx, undefined, OPEN);
    expect((await send(ctx, { method: 'rtdb.set', instance: 'first', path: 'a', value: 1 })).ok).toBe(true);
    expect((await send(ctx, { method: 'rtdb.set', path: 'a', value: 2 })).ok).toBe(true);
    const undeclared = await send(ctx, { method: 'rtdb.get', instance: 'second', path: 'a' });
    expect(undeclared).toMatchObject({ ok: false, error: { code: RTDB_UNKNOWN_INSTANCE_CODE } });
    expect(() => setDatabaseRules(ctx, 'second', OPEN)).toThrow('declares no Realtime Database instance named "second"');
    const snaps: OutboundMessage[] = [];
    await handleMessage(ctx, { postMessage: (message) => snaps.push(message) }, {
      t: 'sub', subId: 'undeclared', target: { service: 'rtdb', instance: 'second', path: 'a' },
    });
    expect(snaps).toMatchObject([{ t: 'snap', subId: 'undeclared', value: { __error: { code: RTDB_UNKNOWN_INSTANCE_CODE } } }]);
    expect([...ctx.rtdbInstances!.entries()].map(([key]) => key).sort()).toEqual(['declared-project-default-rtdb', 'first']);
  });

  it('creates undeclared instances on demand when the project declares none', async () => {
    const ctx = makeCtx();
    ctx.rtdbDefaultPolicy = 'allow';
    expect((await send(ctx, { method: 'rtdb.set', instance: 'on-demand', path: 'a', value: 1 })).ok).toBe(true);
    expect(await value(ctx, 'on-demand', 'a')).toBe(1);
  });

  it('runs a port\'s onDisconnect operations per instance', async () => {
    const ctx = makeCtx();
    for (const instance of ['first', 'second']) setDatabaseRules(ctx, instance, OPEN);
    const port = makePort();
    for (const instance of ['first', 'second']) {
      const queued = await send(ctx, { method: 'rtdb.onDisconnectSet', instance, path: 'presence', value: instance }, port);
      expect(queued.ok).toBe(true);
    }
    // Each instance is its own connection: taking one offline runs only its operations.
    expect((await send(ctx, { method: 'rtdb.goOffline', instance: 'first' }, port)).ok).toBe(true);
    expect(await value(ctx, 'first', 'presence')).toBe('first');
    expect(await value(ctx, 'second', 'presence')).toBeNull();
    await drainPortRtdbDisconnects(ctx, port);
    expect(await value(ctx, 'second', 'presence')).toBe('second');
  });

  it('restores each instance\'s rules after resetAll', async () => {
    const ctx = makeCtx();
    setDatabaseRules(ctx, 'first', OPEN);
    setDatabaseRules(ctx, 'second', { rules: { '.read': false, '.write': false } });
    expect((await send(ctx, { method: 'resetAll' })).ok).toBe(true);
    expect((await send(ctx, { method: 'rtdb.set', instance: 'first', path: 'a', value: 1 })).ok).toBe(true);
    expect((await send(ctx, { method: 'rtdb.set', instance: 'second', path: 'a', value: 1 })).ok).toBe(false);
  });
});
