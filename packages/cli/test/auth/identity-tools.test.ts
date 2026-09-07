/**
 * `auth_impersonate`, `auth_reset`, `auth_whoami`, and `auth_sessions`
 * against a live client registry and a live caller identity: every mode, the
 * exactly-one-of validation, `tenant` and `claims` reaching the stored shape,
 * self versus target, and the two absent-state paths (no bridge in this
 * process, and a bridge with no client under the requested target id).
 *
 * The registry is the bridge's own (`createConsumerRegistry`), so a targeted
 * call here exercises the same `remote-lens` fan-out a Studio-driven one does.
 */
import { describe, expect, it } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';
import { createConsumerRegistry } from '../../src/bridge/server/consumer-registry.js';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import { createAuthIdentityTools } from '../../src/auth/identity-tools.js';
import {
  NO_BRIDGE_MESSAGE,
  SELF_SCOPE_NOTE,
  TARGET_SCOPE_NOTE,
  createCallerIdentity,
} from '../../src/auth/identity.js';

interface Result {
  ok: boolean;
  summary: string;
  data?: unknown;
}

const ctx = { signal: new AbortController().signal } as never;

const NAMES = ['auth_impersonate', 'auth_reset', 'auth_whoami', 'auth_sessions'];

function toolset(deps: Parameters<typeof createAuthIdentityTools>[0] = {}) {
  const handlers = createAuthIdentityTools(deps);
  expect(handlers.map((handler) => handler.name)).toEqual(NAMES);
  const byName = new Map(handlers.map((handler) => [handler.name, handler]));
  return (name: string): ToolHandler => byName.get(name)!;
}

function withClient(clientSessionId = 'sess-1') {
  const registry = createConsumerRegistry();
  const caller = createCallerIdentity();
  const frames: BridgeMessage[] = [];
  registry.register({
    clientSessionId,
    platform: 'flutter',
    deviceLabel: 'iPhone 17 Pro',
    connectedAt: 1000,
    lastSeen: 1000,
    activeLens: { mode: 'app-session' },
    send: (msg) => frames.push(msg),
  });
  return { registry, caller, frames, tool: toolset({ sessions: registry, caller }) };
}

function call(tool: ToolHandler, args: Record<string, unknown> = {}): Promise<Result> {
  return tool.execute(args, ctx) as Promise<Result>;
}

describe('auth_sessions', () => {
  it('reports each connected client with the identity it acts as', async () => {
    const { tool } = withClient();
    const result = await call(tool('auth_sessions'));

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('1 connected client');
    const sessions = (result.data as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      target: 'sess-1',
      platform: 'flutter',
      deviceLabel: 'iPhone 17 Pro',
      identity: 'app session',
      identityDetail: { mode: 'app-session' },
    });
  });

  it('reports an empty registry without failing', async () => {
    const tool = toolset({ sessions: createConsumerRegistry(), caller: createCallerIdentity() });
    const result = await call(tool('auth_sessions'));

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('No clients are connected to this bridge.');
    expect(result.data).toMatchObject({ total: 0 });
  });
});

describe('auth_impersonate on a target', () => {
  it('sets admin and notifies the client', async () => {
    const { tool, registry, frames } = withClient();
    const result = await call(tool('auth_impersonate'), { admin: true, target: 'sess-1' });

    expect(result.ok).toBe(true);
    expect(registry.get('sess-1')?.activeLens).toEqual({ mode: 'admin' });
    expect(frames).toContainEqual({
      type: 'worker-event',
      event: 'remote-lens',
      clientSessionId: 'sess-1',
      lens: { mode: 'admin' },
    });
  });

  it('sets anonymous, and auth_reset returns it to the app session', async () => {
    const { tool, registry } = withClient();

    await call(tool('auth_impersonate'), { anonymous: true, target: 'sess-1' });
    expect(registry.get('sess-1')?.activeLens).toEqual({ mode: 'anon' });

    await call(tool('auth_reset'), { target: 'sess-1' });
    expect(registry.get('sess-1')?.activeLens).toEqual({ mode: 'app-session' });
  });

  it('sets a bare uid', async () => {
    const { tool, registry } = withClient();
    const result = await call(tool('auth_impersonate'), { uid: 'alice', target: 'sess-1' });

    expect(result.ok).toBe(true);
    expect(registry.get('sess-1')?.activeLens).toEqual({ mode: 'as', uid: 'alice' });
    expect(result.summary).toContain('as alice');
  });

  it('carries tenant and claims through to the stored identity', async () => {
    const { tool, registry, frames } = withClient();
    const result = await call(tool('auth_impersonate'), {
      uid: 'alice',
      tenant: 'tenant-acme',
      claims: { role: 'editor', tier: 2 },
      target: 'sess-1',
    });

    expect(result.ok).toBe(true);
    expect(registry.get('sess-1')?.activeLens).toEqual({
      mode: 'as',
      uid: 'alice',
      tenant: 'tenant-acme',
      token: { role: 'editor', tier: 2 },
    });
    expect(result.summary).toContain('tenant tenant-acme');
    expect(result.summary).toContain('claims role,tier');
    expect(frames.at(-1)).toMatchObject({
      event: 'remote-lens',
      lens: { mode: 'as', uid: 'alice', tenant: 'tenant-acme', token: { role: 'editor', tier: 2 } },
    });
  });

  it('names the connected targets on a miss and leaves the caller alone', async () => {
    const { tool, caller } = withClient();

    const miss = await call(tool('auth_impersonate'), { admin: true, target: 'sess-9' });
    expect(miss).toMatchObject({ ok: false, data: { code: 'auth/unknown-session' } });
    expect(miss.summary).toContain('sess-1');
    expect(caller.get()).toEqual({ mode: 'app-session' });
  });
});

describe('auth_impersonate on yourself', () => {
  it('records the caller identity, which auth_whoami reads back', async () => {
    const { tool, caller, registry } = withClient();

    const set = await call(tool('auth_impersonate'), {
      uid: 'alice',
      claims: { role: 'editor' },
    });
    expect(set.ok).toBe(true);
    expect(caller.get()).toEqual({ mode: 'as', uid: 'alice', token: { role: 'editor' } });
    // A self call must not touch any connected client.
    expect(registry.get('sess-1')?.activeLens).toEqual({ mode: 'app-session' });

    const who = await call(tool('auth_whoami'));
    expect(who.ok).toBe(true);
    expect(who.summary).toContain('as alice');
    expect(who.data).toMatchObject({ identityDetail: { mode: 'as', uid: 'alice' } });
  });

  it('starts on the app session and auth_reset returns to it', async () => {
    const { tool, caller } = withClient();

    expect((await call(tool('auth_whoami'))).summary).toContain('app session');
    await call(tool('auth_impersonate'), { admin: true });
    expect(caller.get()).toEqual({ mode: 'admin' });

    const reset = await call(tool('auth_reset'));
    expect(reset.ok).toBe(true);
    expect(caller.get()).toEqual({ mode: 'app-session' });
  });

  it('requires exactly one of uid, admin, and anonymous', async () => {
    const { tool } = withClient();

    for (const args of [{}, { admin: true, anonymous: true }, { uid: 'a', admin: true }]) {
      const result = await call(tool('auth_impersonate'), args);
      expect(result).toMatchObject({ ok: false, data: { code: 'auth/argument-error' } });
      expect(result.summary).toContain('exactly one of uid, admin: true, or anonymous: true');
    }
  });

  it('validates uid, tenant, and claims', async () => {
    const { tool } = withClient();

    expect(await call(tool('auth_impersonate'), { uid: '' })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call(tool('auth_impersonate'), { uid: 'a', tenant: 7 })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call(tool('auth_impersonate'), { uid: 'a', claims: 'role' })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    const misplaced = await call(tool('auth_impersonate'), { admin: true, tenant: 't' });
    expect(misplaced.summary).toContain('require uid');
  });
});

describe('auth identity tools without a bridge', () => {
  it('compose their names and degrade on call rather than throwing', async () => {
    const tool = toolset();

    for (const [name, args] of [
      ['auth_impersonate', { admin: true }],
      ['auth_impersonate', { admin: true, target: 'sess-1' }],
      ['auth_reset', {}],
      ['auth_whoami', {}],
      ['auth_sessions', {}],
    ] as const) {
      const result = await call(tool(name), args as Record<string, unknown>);
      expect(result).toMatchObject({ ok: false, data: { code: 'auth/no-bridge' } });
      expect(result.summary).toBe(NO_BRIDGE_MESSAGE);
    }
  });
});

/**
 * The two claims that must never be quietly dropped, and must never be
 * confused for each other: the caller's own identity DOES govern the tool
 * calls the bridge forwards (`dispatchSandbox` stamps it on the `tool-call`
 * frame), and a targeted identity still does not.
 */
describe('the scope the descriptions promise', () => {
  const SELF_PHRASE = 'applied to the tool calls you forward through it';
  const TARGET_PHRASE = 'does not change how your own tool calls are rules-evaluated';

  it('states that the caller identity governs the calls the caller forwards', () => {
    const tool = toolset();

    expect(SELF_SCOPE_NOTE).toContain(SELF_PHRASE);
    expect(SELF_SCOPE_NOTE).toContain('the Firestore data tools run under this identity');
    expect(tool('auth_impersonate').description).toContain(SELF_PHRASE);
    expect(tool('auth_reset').description).toContain(SELF_PHRASE);
    expect(tool('auth_whoami').description).toContain(SELF_PHRASE);
  });

  it('names the per-call argument that outranks it and the tools it does not reach', () => {
    expect(SELF_SCOPE_NOTE).toContain(
      'A call that passes its own as argument uses that instead, and the recorded identity is unchanged.',
    );
    expect(SELF_SCOPE_NOTE).toContain(
      'sandbox_inspect, the rules simulator, the Realtime Database inspectors, and the auth user ' +
        'tools take no identity and keep bypassing rules.',
    );
    expect(SELF_SCOPE_NOTE).toContain('admin bypasses them');
  });

  it('keeps the target claim distinct: another client is not you', () => {
    const tool = toolset();

    expect(TARGET_SCOPE_NOTE).toContain('This applies to the named client only.');
    expect(TARGET_SCOPE_NOTE).toContain(TARGET_PHRASE);
    expect(SELF_SCOPE_NOTE).not.toContain(TARGET_PHRASE);
    expect(tool('auth_impersonate').description).toContain(TARGET_PHRASE);
    expect(tool('auth_reset').description).toContain(TARGET_PHRASE);
    expect(tool('auth_whoami').description).not.toContain(TARGET_PHRASE);
  });

  it('repeats the claim in the result of a successful call', async () => {
    const { tool } = withClient();

    expect((await call(tool('auth_impersonate'), { admin: true })).summary).toContain(SELF_PHRASE);
    expect((await call(tool('auth_reset'))).summary).toContain(SELF_PHRASE);
    expect((await call(tool('auth_whoami'))).summary).toContain(SELF_PHRASE);
    expect(
      (await call(tool('auth_impersonate'), { admin: true, target: 'sess-1' })).summary,
    ).toContain(TARGET_PHRASE);
  });

  it('never says lens on the surface', () => {
    const tool = toolset();
    for (const name of NAMES) {
      expect(name).not.toContain('lens');
      expect(tool(name).description.toLowerCase()).not.toContain('lens');
      expect(JSON.stringify(tool(name).parameters).toLowerCase()).not.toContain('lens');
    }
  });
});
