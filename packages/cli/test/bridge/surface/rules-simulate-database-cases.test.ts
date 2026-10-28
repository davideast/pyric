/**
 * `rules.simulate` for the database service reaches the whole rules engine: a
 * scalar write, a multi-path `update`, and a read that carries a query. Each
 * kind is checked against the running sandbox's rules, against a supplied
 * ruleset, and in a batch, and each is refused for a service that has no such
 * request.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

const RULES = {
  rules: {
    '.read': false,
    '.write': false,
    score: { '.write': 'auth != null', '.validate': 'newData.isNumber()' },
    flag: { '.write': 'auth != null', '.validate': 'newData.val() == true' },
    totals: {
      '.write': 'auth != null',
      '.validate': "newData.val() == newData.parent().child('score').val() + 1",
    },
    items: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" },
    feed: { '.read': 'query.orderByKey == true && query.limitToFirst <= 10' },
  },
};
const RULES_TEXT = JSON.stringify(RULES);

const surface = renderSurface(undefined);

function runningContext(): SurfaceContext {
  const sandbox = initializeSandbox();
  setRules(sandbox, RULES);
  return createSurfaceContext(sandbox);
}

async function simulate(ctx: SurfaceContext, args: Record<string, unknown>): Promise<OperationResult> {
  const tool = surface.tools.find((candidate) => candidate.name === 'rules');
  if (tool === undefined) throw new Error('no rules tool');
  return tool.execute({ method: 'simulate', args: { service: 'database', ...args } }, ctx);
}

const decision = (result: OperationResult) => (result.data as { decision?: string }).decision;

describe.each([
  ['the running sandbox rules', (args: Record<string, unknown>) => args],
  ['a supplied ruleset', (args: Record<string, unknown>) => ({ ...args, rules: RULES_TEXT })],
])('rules.simulate for database against %s', (_label, shape) => {
  const run = (args: Record<string, unknown>) => simulate(runningContext(), shape(args));

  it('evaluates a scalar write', async () => {
    expect(decision(await run({ operation: 'write', path: 'score', uid: 'alice', data: 5 }))).toBe('ALLOW');
    expect(decision(await run({ operation: 'write', path: 'score', uid: 'alice', data: 'five' }))).toBe('DENY');
    expect(decision(await run({ operation: 'write', path: 'flag', uid: 'alice', data: true }))).toBe('ALLOW');
    expect(decision(await run({ operation: 'write', path: 'flag', uid: 'alice', data: false }))).toBe('DENY');
  });

  it('evaluates a multi-path update as one atomic write', async () => {
    const allowed = await run({ operation: 'update', path: '/', uid: 'alice', data: { score: 4, totals: 5 } });
    expect(decision(allowed)).toBe('ALLOW');
    const denied = await run({ operation: 'update', path: '/', uid: 'alice', data: { score: 4, totals: 9 } });
    expect(decision(denied)).toBe('DENY');
    expect((denied.data as { matchedPath: string }).matchedPath).toContain('totals');
  });

  it('evaluates a read that carries a query', async () => {
    const owner = await run({ operation: 'read', path: 'items', uid: 'alice', query: { orderByChild: 'owner', equalTo: 'alice' } });
    expect(decision(owner)).toBe('ALLOW');
    const other = await run({ operation: 'read', path: 'items', uid: 'alice', query: { orderByChild: 'owner', equalTo: 'bob' } });
    expect(decision(other)).toBe('DENY');
    expect(decision(await run({ operation: 'read', path: 'items', uid: 'alice' }))).toBe('DENY');
    const limited = await run({ operation: 'read', path: 'feed', uid: 'alice', query: { orderByKey: true, limitToFirst: 11 } });
    expect(decision(limited)).toBe('DENY');
  });
});

describe('rules.simulate for database in a batch', () => {
  it('answers every case kind in order', async () => {
    const result = await simulate(runningContext(), {
      cases: [
        { operation: 'write', path: 'score', uid: 'alice', data: 5 },
        { operation: 'update', path: '/', uid: 'alice', data: { score: 4, totals: 9 } },
        { operation: 'read', path: 'items', uid: 'alice', query: { orderByChild: 'owner', equalTo: 'alice' } },
      ],
    });
    const verdicts = (result.data as { cases: Array<{ allowed: boolean }> }).cases.map((c) => c.allowed);
    expect(verdicts).toEqual([true, false, true]);
  });
});

describe('rules.simulate for database names the deciding rule', () => {
  it('returns matchedRule for a supplied ruleset', async () => {
    const result = await simulate(runningContext(), {
      operation: 'write', path: 'score', uid: 'alice', data: 5, rules: RULES_TEXT,
    });
    expect((result.data as { matchedRule: string }).matchedRule).toBe('auth != null');
  });
});

describe('rules.simulate refuses what the service has no request for', () => {
  it('a query on a firestore request', async () => {
    const result = await simulate(runningContext(), {
      service: 'firestore', operation: 'get', path: 'users/alice', query: { orderByKey: true },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('query');
  });

  it('a scalar data value on a firestore request', async () => {
    const result = await simulate(runningContext(), {
      service: 'firestore', operation: 'create', path: 'users/alice', data: 5,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('data');
  });

  it('a query on a database write', async () => {
    const result = await simulate(runningContext(), {
      operation: 'write', path: 'score', uid: 'alice', data: 5, query: { orderByKey: true },
    });
    expect(result.ok).toBe(false);
  });
});
