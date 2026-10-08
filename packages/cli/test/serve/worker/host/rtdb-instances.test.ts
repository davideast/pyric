/**
 * The host's RTDB instances: protocol `instance` routing, per-instance rules
 * through the op and the exported host API, locked instances without rules,
 * per-instance onDisconnect connections, and reset restoring each instance's
 * rules. The SharedWorker and the Node host run this same dispatch.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAdminDatabase, get, ref } from 'pyric/database';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import {
  databaseInstanceRulesHost,
  resolvePendingDatabaseTargets,
  setDatabaseRules,
  setDatabaseTargetRules,
} from '../../../../src/serve/worker/host/rules.js';
import { connectDatabaseInstanceRules, createPendingDatabaseTargets } from '../../../../src/serve/database-instance-rules-host.js';
import { drainPortRtdbDisconnects } from '../../../../src/serve/worker/host/rtdb.js';
import {
  type InboundMessage,
  type OutboundMessage,
  type ResMessage,
} from '../../../../src/serve/worker/protocol.js';

const OPEN = { rules: { '.read': true, '.write': true } };

/** The Pyric RTDB notices `console.warn` writes while capturing. */
function captureWarnings(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return {
    get lines() { return lines.filter((line) => line.startsWith('pyric: RTDB')); },
    restore: () => { console.warn = warn; },
  };
}

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

  it('creates an instance without deployed rules on first use, denying every read and write, and says how to deploy its rules once', async () => {
    const ctx = makeCtx('locked-project');
    const warnings = captureWarnings();
    try {
      const denied = await send(ctx, { method: 'rtdb.set', instance: 'on-demand', path: 'a', value: 1 });
      expect(denied.ok).toBe(false);
      expect((await send(ctx, { method: 'rtdb.get', instance: 'on-demand', path: 'a' })).ok).toBe(false);
      expect(warnings.lines).toEqual([
        'pyric: RTDB instance "on-demand" has no rules in firebase.json; it denies all reads and writes. Add {"instance": "on-demand", "rules": "<file>"} to the database array.',
      ]);
      // Deployed rules replace the locked default, as a production deploy does.
      setDatabaseRules(ctx, 'on-demand', OPEN);
      expect((await send(ctx, { method: 'rtdb.set', instance: 'on-demand', path: 'a', value: 1 })).ok).toBe(true);
      expect(warnings.lines).toHaveLength(1);
    } finally {
      warnings.restore();
    }
  });

  it('under permissive mode, opens an instance without deployed rules as it opens the default instance, and says so once', async () => {
    const ctx = makeCtx('permissive-project');
    ctx.rtdbDefaultPolicy = 'allow';
    const warnings = captureWarnings();
    try {
      expect((await send(ctx, { method: 'rtdb.set', instance: 'on-demand', path: 'a', value: 1 })).ok).toBe(true);
      expect((await send(ctx, { method: 'rtdb.get', instance: 'on-demand', path: 'a' })).ok).toBe(true);
      expect(warnings.lines).toEqual([
        'pyric: RTDB instance "on-demand" has no rules in firebase.json; permissive mode allows all reads and writes. Add {"instance": "on-demand", "rules": "<file>"} to the database array.',
      ]);
    } finally {
      warnings.restore();
    }
  });

  it('lists the instances firebase.json declares, before any of them is used', () => {
    const ctx = makeCtx('declared-project');
    databaseInstanceRulesHost(ctx).declareInstances(new Set(['declared-project-default-rtdb', 'first']));
    expect([...ctx.rtdbInstances!.entries()].map(([key]) => key).sort()).toEqual(['declared-project-default-rtdb', 'first']);
  });

  it('serves the array\'s default instance rules to getDatabase(app) when no project id was known at startup', async () => {
    // firebase.json names `p-default-rtdb`; without .firebaserc or --project
    // the loader cannot tell that name is the default instance's.
    const ctx = makeCtx();
    connectDatabaseInstanceRules(databaseInstanceRulesHost(ctx), {
      defaultInstance: '(default)',
      rules: { 'p-default-rtdb': OPEN },
    });
    await handleMessage(ctx, sharedPort, { t: 'appConfig', options: { projectId: 'p' } });
    expect((await send(ctx, { method: 'rtdb.set', path: 'a', value: 1 })).ok).toBe(true);
    expect(await value(ctx, 'p-default-rtdb', 'a')).toBe(1);
    expect(await send(ctx, { method: 'getRulesStatus', service: 'database' }))
      .toMatchObject({ ok: true, value: { status: 'active', source: OPEN } });
  });

  it('applies an unresolved deploy target\'s rules once the app config names a project .firebaserc maps it for', async () => {
    const ctx = makeCtx();
    ctx.pendingDatabaseTargets = createPendingDatabaseTargets([
      { target: 'main', rules: OPEN, instancesByProject: { p: ['main-a'], q: ['q-main'] } },
    ]);
    const info = console.info;
    const notices: string[] = [];
    console.info = (...args: unknown[]) => { notices.push(args.map(String).join(' ')); };
    const warnings = captureWarnings();
    try {
      // Before the app config, the target's instance is locked like any undeployed instance.
      expect((await send(ctx, { method: 'rtdb.set', instance: 'main-a', path: 'a', value: 1 })).ok).toBe(false);
      await handleMessage(ctx, sharedPort, { t: 'appConfig', options: { projectId: 'p' } });
    } finally {
      console.info = info;
      warnings.restore();
    }
    expect(notices).toContain('[pyric] RTDB deploy target "main" resolved with the app config project "p": its rules now apply to instance main-a.');
    expect((await send(ctx, { method: 'rtdb.set', instance: 'main-a', path: 'a', value: 1 })).ok).toBe(true);
    expect(await value(ctx, 'main-a', 'a')).toBe(1);
    // A later rules change for the target reaches its resolved instance.
    expect(setDatabaseTargetRules(ctx, 'main', { rules: { '.read': true, '.write': false } }).ok).toBe(true);
    expect((await send(ctx, { method: 'rtdb.set', instance: 'main-a', path: 'b', value: 1 })).ok).toBe(false);
  });

  it('resolves unresolved deploy targets at init when an app port named its project first', async () => {
    const ctx = makeCtx();
    await handleMessage(ctx, sharedPort, { t: 'appConfig', options: { projectId: 'p' } });
    ctx.pendingDatabaseTargets = createPendingDatabaseTargets([
      { target: 'main', rules: OPEN, instancesByProject: { p: ['main-a'] } },
    ]);
    const info = console.info;
    console.info = () => {};
    try {
      resolvePendingDatabaseTargets(ctx);
    } finally {
      console.info = info;
    }
    expect((await send(ctx, { method: 'rtdb.set', instance: 'main-a', path: 'a', value: 1 })).ok).toBe(true);
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
