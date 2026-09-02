/**
 * The `database_data` tool through the composed surface and the sandbox
 * dispatcher: every op validates against its own schema on the MCP side and
 * executes against a seeded tree on the sandbox side, with `as` selecting
 * admin bypass or a rules-enforced user.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules, snapshotState } from 'pyric/sandbox/database';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { getDefaultMcpToolSurface } from '../../src/bridge/server/mcp-contract.js';
import { resolveToolCall } from '../../src/bridge/server/tool-surface.js';

const OPS = ['crawl', 'get', 'set', 'update', 'remove', 'push', 'transaction', 'query', 'seed'];

const RULES = {
  rules: {
    rooms: {
      $room: {
        '.read': 'auth != null',
        messages: {
          $id: { '.write': 'auth != null && newData.child("author").val() === auth.uid' },
        },
      },
    },
    scores: { '.read': true, '.write': false },
  },
};

const TREE = {
  rooms: { r1: { messages: { m1: { author: 'alice', body: 'hi' } } } },
  scores: { a: { name: 'Ann', score: 30 }, b: { name: 'Ben', score: 10 }, c: { name: 'Cy', score: 20 } },
};

function databaseTool() {
  return getDefaultMcpToolSurface().find((tool) => tool.name === 'database_data')!;
}

describe('database_data on the composed MCP surface', () => {
  it('advertises the ratified ops, all forwarded, each with its own schema', () => {
    const tool = databaseTool();
    expect(tool.ops.map((op) => op.op)).toEqual(OPS);
    expect(tool.ops.every((op) => op.transport === 'forwarded')).toBe(true);
    expect(tool.parameters.properties!.op!.enum).toEqual(OPS);
    const fields = Object.fromEntries(tool.ops.map((op) => [op.op, op.fields.map((field) => field.name)]));
    expect(fields).toEqual({
      crawl: ['path', 'maxDepth', 'maxChildren'],
      get: ['path', 'as'],
      set: ['path', 'value', 'as'],
      update: ['path', 'values', 'as'],
      remove: ['path', 'as'],
      push: ['path', 'value', 'as'],
      transaction: ['path', 'value', 'expect', 'as'],
      query: [
        'path', 'orderBy', 'childKey', 'limitToFirst', 'limitToLast',
        'startAt', 'startAfter', 'endAt', 'endBefore', 'equalTo', 'as',
      ],
      seed: ['path', 'value'],
    });
  });

  it('documents the write sentinels on set, update, and push', () => {
    const tool = databaseTool();
    for (const op of ['set', 'update', 'push']) {
      const description = tool.ops.find((candidate) => candidate.op === op)!.description;
      expect(description).toContain('{ ".sv": "timestamp" }');
      expect(description).toContain('{ ".sv": { "increment": n } }');
    }
  });

  it('validates a call against the fields of the op it names', () => {
    const tool = databaseTool();
    const valid = resolveToolCall(tool, { op: 'set', path: '/a', value: 1, as: { uid: 'u' } });
    expect(valid.ok).toBe(true);

    const missing = resolveToolCall(tool, { op: 'set', path: '/a' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.result.summary).toStartWith('database_data.set: invalid fields:');
      expect((missing.result.data as { issues: Array<{ field: string }> }).issues.map((issue) => issue.field)).toEqual(['value']);
    }

    const foreign = resolveToolCall(tool, { op: 'get', path: '/a', value: 1 });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.result.summary).toContain("'value' is not a field of op 'get'");

    const badOrder = resolveToolCall(tool, { op: 'query', path: '/a', orderBy: 'score' });
    expect(badOrder.ok).toBe(false);

    const unknown = resolveToolCall(tool, { op: 'validated_write', path: '/a' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.result.summary).toContain(`valid ops: ${OPS.join(', ')}`);
  });
});

describe('database_data through the sandbox dispatcher', () => {
  it('seeds a tree and round-trips every op with rules enforced for users', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, RULES);
    const dispatch = buildSandboxDispatcher(sandbox);
    const call = (op: string, args: Record<string, unknown>) => dispatch('database_data', op, args);

    // seed replaces the tree as admin.
    expect((await call('seed', { value: TREE })).ok).toBe(true);
    expect(snapshotState(sandbox)).toEqual(TREE);

    // get as admin and as a user with read access.
    const admin = await call('get', { path: '/rooms/r1/messages/m1' });
    expect(admin.data).toEqual({ exists: true, value: { author: 'alice', body: 'hi' } });
    const asBob = await call('get', { path: '/rooms/r1/messages/m1', as: { uid: 'bob' } });
    expect(asBob.data).toEqual({ exists: true, value: { author: 'alice', body: 'hi' } });

    // set as the author is allowed; a forged author is denied; admin bypasses.
    expect((await call('set', {
      path: '/rooms/r1/messages/m2',
      value: { author: 'bob', body: 'hey' },
      as: { uid: 'bob' },
    })).ok).toBe(true);
    await expect(call('set', {
      path: '/rooms/r1/messages/m3',
      value: { author: 'alice', body: 'forged' },
      as: { uid: 'bob' },
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('set', { path: '/scores/z', value: 1, as: { uid: 'bob' } }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await call('set', { path: '/scores/z', value: { name: 'Zed', score: 5 }, as: 'admin' })).ok).toBe(true);

    // update as a multi-path map; a user denied on one path fails the whole write.
    expect((await call('update', {
      path: '/scores',
      values: { 'a/score': 31, 'z/score': 6 },
    })).summary).toBe('Updated 2 paths under /scores');
    await expect(call('update', {
      path: '/',
      values: { 'rooms/r1/messages/m4': { author: 'bob', body: 'x' }, 'scores/z/score': 7 },
      as: { uid: 'bob' },
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const state = snapshotState(sandbox) as typeof TREE & { rooms: { r1: { messages: Record<string, unknown> } } };
    expect(state.rooms.r1.messages.m4).toBeUndefined();
    expect(state.scores.a.score).toBe(31);

    // push returns the key; the write follows rules for the user.
    const pushed = await call('push', {
      path: '/rooms/r1/messages',
      value: { author: 'bob', body: 'pushed' },
      as: { uid: 'bob' },
    });
    const { key, path } = pushed.data as { key: string; path: string };
    expect(path).toBe(`/rooms/r1/messages/${key}`);
    expect((await call('get', { path })).data).toEqual({ exists: true, value: { author: 'bob', body: 'pushed' } });

    // transaction: compare-and-set aborts on mismatch and returns the current value.
    const aborted = await call('transaction', { path: '/scores/a/score', value: 40, expect: 30 });
    expect(aborted.data).toEqual({ committed: false, value: 31 });
    const committed = await call('transaction', { path: '/scores/a/score', value: 40, expect: 31 });
    expect(committed.data).toEqual({ committed: true, value: 40 });

    // query: orderBy child plus limitToFirst.
    const query = await call('query', {
      path: '/scores',
      orderBy: 'child',
      childKey: 'score',
      limitToFirst: 2,
    });
    expect(query.data).toEqual({
      count: 2,
      rows: [
        { key: 'z', value: { name: 'Zed', score: 6 } },
        { key: 'b', value: { name: 'Ben', score: 10 } },
      ],
    });

    // remove deletes the subtree.
    expect((await call('remove', { path: '/scores/z' })).ok).toBe(true);
    expect((await call('get', { path: '/scores/z' })).data).toEqual({ exists: false, value: null });

    // The sentinels resolve through the sandbox.
    await call('set', { path: '/scores/a/score', value: { '.sv': { increment: 2 } } });
    expect((await call('get', { path: '/scores/a/score' })).data).toEqual({ exists: true, value: 42 });
  });
});
