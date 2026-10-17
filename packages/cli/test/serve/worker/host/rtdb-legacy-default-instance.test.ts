/**
 * SharedWorker and Node host: the legacy default instance name, the project
 * id, is the default instance (#1062). An app whose `databaseURL` is
 * `https://<projectId>.firebaseio.com` sends `instance: "<projectId>"`; the
 * host serves it the default instance's data and rules, whether the host
 * knew the project at startup or learns it from the app's config.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { databaseInstanceRulesHost, setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { hostDatabaseInstances } from '../../../../src/serve/worker/host/rtdb-instance-catalog.js';
import { connectDatabaseInstanceRules } from '../../../../src/serve/database-instance-rules-host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../../src/serve/worker/protocol.js';

const PROJECT = 'legacy-host';
const DEFAULT_RULES = {
  rules: {
    open: { '.read': true, '.write': true },
    closed: { '.read': false, '.write': false },
  },
};

function makeCtx(options: { knowsProject: boolean }): HostCtx {
  const sandbox = initializeSandbox();
  // A project known at startup reaches the host as serve-init sets it from the init payload.
  const defaultName = options.knowsProject ? { defaultRtdbInstance: `${PROJECT}-default-rtdb`, rtdbProjectId: PROJECT } : {};
  return { db: getFirestore(sandbox), sandbox, instanceId: 'rtdb-legacy-default', subs: new Map(), ...defaultName };
}

const port: PortLike & { pending: Map<string, (reply: ResMessage) => void> } = {
  pending: new Map(),
  postMessage(reply: OutboundMessage) {
    if (reply.t === 'res') this.pending.get(reply.id)?.(reply);
  },
};
let sequence = 0;
function send(ctx: HostCtx, message: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const id = `legacy-${++sequence}`;
    port.pending.set(id, resolve);
    void handleMessage(ctx, port, { t: 'op', id, ...message } as InboundMessage);
  });
}

async function adminValue(ctx: HostCtx, instance: string | undefined, path: string): Promise<unknown> {
  const reply = await send(ctx, { method: 'rtdb.get', path, actAs: { mode: 'admin' }, ...(instance ? { instance } : {}) });
  if (!reply.ok) throw new Error(reply.error.message);
  return (reply.value as { value: unknown }).value;
}

function appConfig(ctx: HostCtx): Promise<void> {
  return handleMessage(ctx, port, {
    t: 'appConfig',
    options: { projectId: PROJECT, databaseURL: `https://${PROJECT}.firebaseio.com` },
  });
}

/** The app's writes on instance `<projectId>`: one the default rules allow, one they deny. */
async function expectDefaultRulesOnLegacyName(ctx: HostCtx): Promise<void> {
  const allowed = await send(ctx, { method: 'rtdb.set', instance: PROJECT, path: 'open/a', value: 'legacy' });
  expect(allowed.ok ? 'ok' : allowed.error.message).toBe('ok');
  const denied = await send(ctx, { method: 'rtdb.set', instance: PROJECT, path: 'closed/a', value: 'legacy' });
  expect(denied.ok).toBe(false);
  expect(await adminValue(ctx, undefined, 'open/a')).toBe('legacy');
}

describe('host RTDB legacy default instance name', () => {
  it('serves the default instance rules to <projectId> when the project is known at startup', async () => {
    const ctx = makeCtx({ knowsProject: true });
    setDatabaseRules(ctx, undefined, DEFAULT_RULES);
    await appConfig(ctx);
    await expectDefaultRulesOnLegacyName(ctx);
    expect([...ctx.rtdbInstances!.entries()].map(([key]) => key)).toEqual([`${PROJECT}-default-rtdb`]);
  });

  it('serves firebase.json database.rules to <projectId> when the app config names the project', async () => {
    // A single `database` object with no .firebaserc: the rules go to the
    // unnamed default before any app names its project.
    const ctx = makeCtx({ knowsProject: false });
    connectDatabaseInstanceRules(databaseInstanceRulesHost(ctx), { defaultInstance: '(default)', rules: { '(default)': DEFAULT_RULES } });
    await appConfig(ctx);
    await expectDefaultRulesOnLegacyName(ctx);
    expect(await send(ctx, { method: 'getRulesStatus', service: 'database', instance: PROJECT }))
      .toMatchObject({ ok: true, value: { status: 'active', source: DEFAULT_RULES } });
  });

  it('moves rules firebase.json deployed to <projectId> to the default instance once the app config names the project', async () => {
    // `[{ "instance": "<projectId>", ... }]` without .firebaserc: the loader
    // cannot tell the name is the default instance's until the app says so.
    const ctx = makeCtx({ knowsProject: false });
    connectDatabaseInstanceRules(databaseInstanceRulesHost(ctx), { defaultInstance: '(default)', rules: { [PROJECT]: DEFAULT_RULES } });
    await appConfig(ctx);
    const allowed = await send(ctx, { method: 'rtdb.set', path: 'open/a', value: 'no url' });
    expect(allowed.ok ? 'ok' : allowed.error.message).toBe('ok');
    expect((await send(ctx, { method: 'rtdb.set', path: 'closed/a', value: 'no url' })).ok).toBe(false);
    expect(await adminValue(ctx, PROJECT, 'open/a')).toBe('no url');
    // The registry was created before the project was known, so the default keeps its unnamed key.
    expect([...ctx.rtdbInstances!.entries()].map(([key]) => key)).toEqual(['(default)']);
  });

  it('refuses different rules for both names learned late, locking the default instance and naming both files', async () => {
    const ctx = makeCtx({ knowsProject: false });
    ctx.rtdbRulesFiles = { [PROJECT]: 'legacy.rules.json', [`${PROJECT}-default-rtdb`]: 'database.rules.json' };
    connectDatabaseInstanceRules(databaseInstanceRulesHost(ctx), {
      defaultInstance: '(default)',
      rules: { [`${PROJECT}-default-rtdb`]: DEFAULT_RULES, [PROJECT]: { rules: { '.read': true, '.write': true } } },
    });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await appConfig(ctx);
    } finally {
      console.error = error;
    }
    expect(errors).toEqual([
      `[pyric] firebase.json deploys two rules files to database instance "${PROJECT}-default-rtdb": database.rules.json to "${PROJECT}-default-rtdb" and legacy.rules.json to "${PROJECT}", which both name the default instance of project "${PROJECT}". The Firebase CLI deploys both at once, so the configuration does not determine which one production keeps. Deploy one rules file to each instance. The default instance stays locked until then.`,
    ]);
    for (const instance of [undefined, PROJECT, `${PROJECT}-default-rtdb`]) {
      const write = await send(ctx, { method: 'rtdb.set', path: 'open/a', value: 1, ...(instance ? { instance } : {}) });
      expect([instance, write.ok]).toEqual([instance, false]);
    }
    expect(await send(ctx, { method: 'getRulesStatus', service: 'database' }))
      .toMatchObject({ ok: true, value: { status: 'error', messages: [{ severity: 'error', text: errors[0]!.slice('[pyric] '.length) }] } });
  });

  it('treats the same rules for both names learned late as one deploy', async () => {
    const ctx = makeCtx({ knowsProject: false });
    connectDatabaseInstanceRules(databaseInstanceRulesHost(ctx), {
      defaultInstance: '(default)',
      rules: { [`${PROJECT}-default-rtdb`]: DEFAULT_RULES, [PROJECT]: DEFAULT_RULES },
    });
    await appConfig(ctx);
    await expectDefaultRulesOnLegacyName(ctx);
  });

  it('recognizes <projectId> from the server before any app port names the project', async () => {
    const ctx = makeCtx({ knowsProject: true });
    setDatabaseRules(ctx, undefined, DEFAULT_RULES);
    expect(hostDatabaseInstances(ctx).select(PROJECT)).toBeUndefined();
    await expectDefaultRulesOnLegacyName(ctx);
  });

  it('keeps one tree for <projectId>, <projectId>-default-rtdb, and no instance', async () => {
    const ctx = makeCtx({ knowsProject: true });
    setDatabaseRules(ctx, PROJECT, DEFAULT_RULES);
    await appConfig(ctx);
    expect((await send(ctx, { method: 'rtdb.set', instance: PROJECT, path: 'open/a', value: 1 })).ok).toBe(true);
    expect(await adminValue(ctx, `${PROJECT}-default-rtdb`, 'open/a')).toBe(1);
    expect(await adminValue(ctx, undefined, 'open/a')).toBe(1);
    expect(await send(ctx, { method: 'getRulesStatus', service: 'database' }))
      .toMatchObject({ ok: true, value: { status: 'active', source: DEFAULT_RULES } });
  });

  it('selects the default instance for <projectId> in the hosted database tools', async () => {
    const ctx = makeCtx({ knowsProject: true });
    await appConfig(ctx);
    expect(hostDatabaseInstances(ctx).select(PROJECT)).toBeUndefined();
  });
});
