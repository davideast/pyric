/**
 * The `instance` argument every `database` method takes: a name, a URL, or
 * `default`, resolved against the instances `firebase.json` declares and the
 * instances the sandbox already holds (#967).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, getAdminDatabase, ref, set } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';

import { TargetRouter } from '../../../../../src/bridge/server/target-router.js';
import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
import { callMethod } from '../../../../../src/bridge/surface/method-call.js';
import { methodByKey } from '../../../../../src/bridge/surface/methods/registry.js';

const surface = renderSurface(undefined);
const SHARD = 'shard-00';

/** A project whose firebase.json declares the default instance and two shards. */
function projectDir(options: { firebaserc?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-database-instance-'));
  writeFileSync(join(dir, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({
    database: [
      { instance: 'demo-app-default-rtdb', rules: 'database.rules.json' },
      { instance: SHARD, rules: 'database.rules.json' },
      { instance: 'shard-01', rules: 'database.rules.json' },
    ],
  }));
  if (options.firebaserc !== false) {
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-app' } }));
  }
  return dir;
}

/** A context over a fresh sandbox, with `rooms` seeded differently on the default instance and the shard. */
async function seeded(options: { firebaserc?: boolean } = {}): Promise<SurfaceContext> {
  const ctx = createSurfaceContext(initializeSandbox(), projectDir(options));
  await set(ref(getAdminDatabase(ctx.sandbox), 'rooms'), {
    lobby: { name: 'default' },
    main: { name: 'default' },
  });
  await set(ref(getAdminDatabase(ctx.sandbox, SHARD), 'rooms'), { lobby: { name: 'shard' } });
  return ctx;
}

async function call(ctx: SurfaceContext, key: string, args: Record<string, unknown>): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`no tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

/** The `rooms` tree of one instance; `undefined` is the default instance. */
async function rooms(ctx: SurfaceContext, instance?: string): Promise<Record<string, Record<string, unknown>>> {
  return (await get(ref(getAdminDatabase(ctx.sandbox, instance), 'rooms'))).val() as Record<string, Record<string, unknown>>;
}

interface Case {
  method: string;
  args: Record<string, unknown>;
  /** Asserts the call reached the shard and left the default instance as seeded. */
  reachedShard(result: OperationResult, ctx: SurfaceContext): Promise<void>;
}

const DEFAULT_SEED = { lobby: { name: 'default' }, main: { name: 'default' } };

const CASES: Case[] = [
  {
    method: 'get',
    args: { path: 'rooms/lobby' },
    reachedShard: async (result) => {
      expect(result.data).toEqual({ exists: true, value: { name: 'shard' } });
    },
  },
  {
    method: 'query',
    args: { path: 'rooms', orderByChild: 'name', equalTo: 'shard' },
    reachedShard: async (result) => {
      expect(result.data).toEqual({ value: { lobby: { name: 'shard' } } });
    },
  },
  {
    method: 'crawl',
    args: { path: 'rooms', depth: 1 },
    reachedShard: async (result) => {
      expect((result.data as { childCount: number }).childCount).toBe(1);
    },
  },
  {
    method: 'set',
    args: { path: 'rooms/new', value: { name: 'new' } },
    reachedShard: async (_result, ctx) => {
      expect((await rooms(ctx, SHARD)).new).toEqual({ name: 'new' });
      expect(await rooms(ctx)).toEqual(DEFAULT_SEED);
    },
  },
  {
    method: 'update',
    args: { path: 'rooms/lobby', values: { topic: 'welcome' } },
    reachedShard: async (_result, ctx) => {
      expect((await rooms(ctx, SHARD)).lobby).toEqual({ name: 'shard', topic: 'welcome' });
      expect(await rooms(ctx)).toEqual(DEFAULT_SEED);
    },
  },
  {
    method: 'remove',
    args: { path: 'rooms/lobby' },
    reachedShard: async (_result, ctx) => {
      expect(await rooms(ctx, SHARD)).toBeNull();
      expect(await rooms(ctx)).toEqual(DEFAULT_SEED);
    },
  },
  {
    method: 'push',
    args: { path: 'rooms', value: { name: 'pushed' } },
    reachedShard: async (result, ctx) => {
      const { key } = result.data as { key: string };
      expect((await rooms(ctx, SHARD))[key]).toEqual({ name: 'pushed' });
      expect(await rooms(ctx)).toEqual(DEFAULT_SEED);
    },
  },
];

const SHARD_FORMS = [
  SHARD,
  'https://shard-00.firebaseio.com',
  'https://shard-00.firebaseio.com/',
  'https://shard-00.europe-west1.firebasedatabase.app',
  'http://localhost:9000/?ns=shard-00',
];

describe('every database method selects the instance it names', () => {
  for (const testCase of CASES) {
    describe(`database.${testCase.method}`, () => {
      it.each(SHARD_FORMS)('reaches the shard named as %s and leaves the default instance alone', async (form) => {
        const ctx = await seeded();
        const result = await call(ctx, `database.${testCase.method}`, { ...testCase.args, instance: form });
        expect(result.ok).toBe(true);
        await testCase.reachedShard(result, ctx);
      });

      it('declares instance in its signature', () => {
        expect(methodByKey(`database.${testCase.method}`).signature).toContain('instance?');
      });
    });
  }
});

describe('the default instance', () => {
  it.each(['default', 'DEFAULT', 'demo-app-default-rtdb', 'https://demo-app-default-rtdb.firebaseio.com'])(
    'is selected by %s',
    async (form) => {
      const ctx = await seeded();
      const result = await call(ctx, 'database.get', { path: 'rooms/lobby', instance: form });
      expect(result.data).toEqual({ exists: true, value: { name: 'default' } });
      expect(result.summary).toBe('Read rooms/lobby');
    },
  );

  it('is what a call with no instance reaches', async () => {
    const ctx = await seeded();
    const result = await call(ctx, 'database.get', { path: 'rooms/lobby' });
    expect(result.data).toEqual({ exists: true, value: { name: 'default' } });
  });
});

describe('the summary', () => {
  it('names a named instance', async () => {
    const ctx = await seeded();
    const result = await call(ctx, 'database.set', { path: 'rooms/new', value: 1, instance: SHARD });
    expect(result.summary).toBe('Wrote rooms/new on shard-00');
  });

  it('does not name the default instance', async () => {
    const ctx = await seeded();
    const result = await call(ctx, 'database.set', { path: 'rooms/new', value: 1, instance: 'default' });
    expect(result.summary).toBe('Wrote rooms/new');
  });
});

describe('an instance the project does not have', () => {
  it('is refused with the instances the project has', async () => {
    const ctx = await seeded();
    const result = await call(ctx, 'database.get', { path: 'rooms/lobby', instance: 'shard-09' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      'database instance "shard-09" is not declared in firebase.json and holds no data in this sandbox. '
        + 'Known instances: demo-app-default-rtdb (default), shard-00, shard-01.',
    );
  });

  it('is not created by the refusal', async () => {
    const ctx = await seeded();
    await call(ctx, 'database.set', { path: 'rooms/new', value: 1, instance: 'shard-09' });
    const again = await call(ctx, 'database.get', { path: 'rooms/new', instance: 'shard-09' });
    expect(again.ok).toBe(false);
  });

  it('is accepted once the sandbox holds data for it, as an app may open an undeclared instance', async () => {
    const ctx = await seeded();
    await set(ref(getAdminDatabase(ctx.sandbox, 'shard-77'), 'rooms/lobby'), { name: 'runtime' });
    const result = await call(ctx, 'database.get', { path: 'rooms/lobby', instance: 'shard-77' });
    expect(result.data).toEqual({ exists: true, value: { name: 'runtime' } });
  });

  it('names the default instance by keyword when no project names it', async () => {
    const ctx = await seeded({ firebaserc: false });
    const result = await call(ctx, 'database.get', { path: 'rooms/lobby', instance: 'shard-09' });
    expect(result.summary).toContain('Known instances: default, demo-app-default-rtdb, shard-00, shard-01.');
  });
});

describe('a malformed instance', () => {
  it.each([
    ['https://shard-00.firebaseio.com/rooms', 'Database URL must point to the root of a Firebase Database'],
    ['https://example', 'Cannot parse Firebase url'],
    ['shard_00', 'Cannot parse Firebase url'],
  ])('%s is rejected before the handler with the SDK message', async (instance, message) => {
    const ctx = await seeded();
    const result = await call(ctx, 'database.get', { path: 'rooms/lobby', instance });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(message);
    expect((result.data as { code: string; field: string })).toMatchObject({ code: 'invalid_arguments', field: 'instance' });
  });
});

describe('a uid identity', () => {
  it("is held to the selected instance's own rules", async () => {
    const ctx = await seeded();
    setRules(getAdminDatabase(ctx.sandbox, SHARD), { rules: { '.read': false, '.write': "auth.uid == 'bob'" } });
    setRules(getAdminDatabase(ctx.sandbox, 'shard-01'), { rules: { '.read': true, '.write': "auth.uid == 'alice'" } });
    expect((await call(ctx, 'auth.createUser', { uid: 'alice', email: 'alice@example.com' })).ok).toBe(true);
    expect((await call(ctx, 'auth.impersonate', { uid: 'alice' })).ok).toBe(true);

    const denied = await call(ctx, 'database.set', { path: 'rooms/a', value: 1, instance: SHARD });
    expect(denied.ok).toBe(false);
    expect(denied.summary).toContain('PERMISSION_DENIED');
    const allowed = await call(ctx, 'database.set', { path: 'rooms/a', value: 1, instance: 'shard-01' });
    expect(allowed.ok).toBe(true);
  });
});

describe('the MCP target router', () => {
  it('hands the hosted call the instance argument unchanged', async () => {
    const ctx = await seeded();
    const received: Array<Record<string, unknown>> = [];
    ctx.targetRouter = new TargetRouter({
      projectDir: ctx.projectDir,
      discover: async () => ({
        url: 'http://127.0.0.1:1', base: 'http://127.0.0.1:1', mcpUrl: 'http://127.0.0.1:1/__pyric/mcp',
        instanceId: 'host', source: 'pointer .pyric/serve.json',
      }),
      callHosted: async (_host, _key, args) => {
        received.push(args);
        return { ok: true, summary: 'Read rooms/lobby on shard-00' };
      },
    });
    const args = { path: 'rooms/lobby', instance: 'https://shard-00.firebaseio.com' };
    const result = await callMethod(methodByKey('database.get'), args, ctx);
    expect(result.summary).toContain('Read rooms/lobby on shard-00');
    expect(received).toEqual([args]);
  });
});
