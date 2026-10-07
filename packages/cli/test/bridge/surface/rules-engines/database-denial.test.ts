/**
 * `rules.explainDenial` for the Realtime Database: which rule decided, the
 * path, rule kind and expression, why it failed (evaluated false, runtime
 * error, or no rule granting anywhere on the cascade), and what would make it
 * allow where that can be stated. The output has the same envelope as the
 * Firestore explanation: `allowed`, `auth`, and a `case` record.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { renderSurface } from '../../../../src/bridge/surface/index.js';
import { DATABASE_RULES } from '../../../../src/bridge/surface/rules-engines/database.js';
import explainDenial from '../../../../src/bridge/surface/methods/rules/explainDenial.js';
import type { OperationResult } from '../../../../src/bridge/surface/types.js';

const surface = renderSurface(undefined);

/** The `case` record an explanation carries for the database. */
interface DenialCase {
  decision: string;
  operation: string;
  path: string;
  matchedPath: string;
  matchedRule: string;
  ruleKind: string;
  why: string;
  reason: string;
  bindings: Record<string, string>;
  runtimeError?: string;
  trace: Array<{
    path: string;
    kind: string;
    conditionText: string;
    verdict: string;
    message?: string;
    pathVariableBindings: Record<string, string>;
    line?: number;
  }>;
  line?: number;
  notes: string[];
  fix?: string;
}

interface Explained {
  allowed: boolean;
  evaluated: 'running' | 'draft';
  auth: { uid: string } | null;
  case: DenialCase;
}

async function explain(
  rules: unknown,
  args: Record<string, unknown>,
  /** Install through the sandbox API, which does not run the load gate `rules.set` runs. */
  ungated = false,
): Promise<{ result: OperationResult; data: Explained }> {
  const ctx = createSurfaceContext(initializeSandbox());
  if (ungated) {
    setRules(ctx.sandbox, { rules: rules as Record<string, unknown> });
  } else {
    const installed = await DATABASE_RULES.install(ctx, JSON.stringify({ rules }));
    expect(installed.ok).toBe(true);
  }
  const tool = surface.tools.find((candidate) => candidate.name === 'rules');
  if (!tool) throw new Error('no rules tool');
  const result = await tool.execute(
    { method: 'explainDenial', args: { service: 'database', ...args } },
    ctx,
  );
  return { result, data: result.data as Explained };
}

describe('explainDenial for database', () => {
  it('names a .write that evaluated false, with the identity that would satisfy it', async () => {
    const { result, data } = await explain(
      { users: { $uid: { '.read': true, '.write': 'auth != null && auth.uid == $uid' } } },
      { operation: 'write', path: 'users/alice', uid: 'bob', data: { name: 'x' } },
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('write users/alice is denied');
    expect(data.allowed).toBe(false);
    expect(data.case).toMatchObject({
      decision: 'DENY',
      operation: 'write',
      path: '/users/alice',
      matchedPath: '/users/$uid',
      matchedRule: 'auth != null && auth.uid == $uid',
      ruleKind: 'write',
      why: 'evaluated-false',
      bindings: { $uid: 'alice' },
    });
    expect(data.case.trace).toEqual([
      {
        path: '/users/$uid',
        kind: 'write',
        conditionText: 'auth != null && auth.uid == $uid',
        verdict: 'DENY',
        pathVariableBindings: { $uid: 'alice' },
      },
    ]);
    expect(data.case.fix).toContain("uid 'alice'");
  });

  it('names a .validate that raised a runtime error', async () => {
    const { data } = await explain(
      {
        scores: {
          $scoreId: { '.write': true, '.validate': "newData.val().beginsWith('a')" },
        },
      },
      { operation: 'write', path: 'scores/s1', uid: 'bob', data: 5 },
    );
    expect(data.allowed).toBe(false);
    expect(data.case).toMatchObject({
      matchedPath: '/scores/$scoreId',
      matchedRule: "newData.val().beginsWith('a')",
      ruleKind: 'validate',
      why: 'runtime-error',
      bindings: { $scoreId: 's1' },
    });
    expect(data.case.runtimeError).toContain("Method 'beginsWith' is not defined on number");
    expect(data.case.reason).toContain('RtdbRuleRuntimeError');
    expect(data.case.fix).toContain('.validate');
  });

  it('reports a .validate that evaluated false while a .write granted', async () => {
    const { data } = await explain(
      { scores: { $scoreId: { '.write': true, '.validate': 'newData.isNumber()' } } },
      { operation: 'write', path: 'scores/s1', uid: 'bob', data: 'text' },
    );
    expect(data.case).toMatchObject({
      ruleKind: 'validate',
      why: 'evaluated-false',
      matchedRule: 'newData.isNumber()',
    });
    expect(data.case.reason).toContain('.write');
  });

  it('reports that no rule grants anywhere on the cascade', async () => {
    const { data } = await explain(
      { rooms: { $roomId: { '.read': true } } },
      { operation: 'write', path: 'rooms/r1/score', uid: 'bob', data: 5 },
    );
    expect(data.allowed).toBe(false);
    expect(data.case).toMatchObject({
      matchedPath: '',
      matchedRule: '',
      ruleKind: 'write',
      why: 'no-rule-grants',
      trace: [],
    });
    expect(data.case.fix).toContain("'.write'");
    expect(data.case.fix).toContain('/rooms/r1/score');
  });

  it('lists every rule of the cascade when each one denied', async () => {
    const { data } = await explain(
      { '.write': false, rooms: { '.write': 'auth.uid == "admin"', $roomId: { '.write': false } } },
      { operation: 'write', path: 'rooms/r1', uid: 'bob', data: 1 },
    );
    expect(data.case.why).toBe('evaluated-false');
    expect(data.case.matchedPath).toBe('/rooms/$roomId');
    expect(data.case.trace.map((entry) => [entry.path, entry.verdict])).toEqual([
      ['/', 'DENY'],
      ['/rooms', 'DENY'],
      ['/rooms/$roomId', 'DENY'],
    ]);
  });

  it('gives a rule that did not decide its own verdict and message', async () => {
    const { data } = await explain(
      {
        rooms: {
          '.write': "newData.val().beginsWith('a')",
          $roomId: { '.write': 'auth.uid == "admin"' },
        },
      },
      { operation: 'write', path: 'rooms/r1', uid: 'bob', data: 5 },
    );
    expect(data.case).toMatchObject({
      why: 'evaluated-false',
      matchedPath: '/rooms/$roomId',
      matchedRule: 'auth.uid == "admin"',
    });
    expect(data.case.trace.map((entry) => [entry.path, entry.verdict])).toEqual([
      ['/rooms', 'ERROR'],
      ['/rooms/$roomId', 'DENY'],
    ]);
    expect(data.case.trace[0].message).toContain("Method 'beginsWith' is not defined on object");
    expect(data.case.trace[1].pathVariableBindings).toEqual({ $roomId: 'r1' });
  });

  const FILE_TEXT = `{
  // Rooms are written by their admin.
  "rules": {
    "rooms": {
      ".write": false,
      "$roomId": {
        ".write": "auth.uid == 'admin'"
      }
    }
  }
}`;
  const FILE_RULES = JSON.parse(FILE_TEXT.replace(/\/\/.*\n/, '')).rules;
  const ROOM_WRITE = { operation: 'write', path: 'rooms/r1', uid: 'bob', data: 1 };

  it('names the file line of each rule when source is the running ruleset', async () => {
    const { data } = await explain(FILE_RULES, { ...ROOM_WRITE, source: FILE_TEXT });
    expect(data.evaluated).toBe('running');
    expect(data.case.trace.map((entry) => entry.line)).toEqual([5, 7]);
    expect(data.case.line).toBe(7);
    expect(data.case.notes).toEqual([]);
  });

  it('omits lines when no source is supplied', async () => {
    const { data } = await explain(FILE_RULES, ROOM_WRITE);
    expect(data.evaluated).toBe('running');
    expect(data.case.trace.map((entry) => entry.line)).toEqual([undefined, undefined]);
    expect(data.case.line).toBeUndefined();
  });

  it('keeps explaining the running ruleset and says so when source is a different ruleset', async () => {
    // The running rules allow the write; the stale text would deny it.
    const { result, data } = await explain({ rooms: { '.write': true } }, { ...ROOM_WRITE, source: FILE_TEXT });
    expect(result.summary).toContain('is allowed');
    expect(data.allowed).toBe(true);
    expect(data.evaluated).toBe('running');
    expect(data.case.trace.every((entry) => entry.line === undefined)).toBe(true);
    expect(data.case.line).toBeUndefined();
    expect(data.case.notes.join(' ')).toContain('not the running ruleset');
  });

  it('evaluates a draft only when rules is passed, and reports it', async () => {
    const { data } = await explain({ rooms: { '.write': true } }, { ...ROOM_WRITE, rules: FILE_TEXT });
    expect(data.evaluated).toBe('draft');
    expect(data.allowed).toBe(false);
    expect(data.case.line).toBe(7);
  });

  it('refuses rules and source together, and either for Firestore', async () => {
    const both = await explain({ '.write': true }, { ...ROOM_WRITE, rules: FILE_TEXT, source: FILE_TEXT });
    expect(both.result.ok).toBe(false);
    const ctx = createSurfaceContext(initializeSandbox());
    const tool = surface.tools.find((candidate) => candidate.name === 'rules')!;
    const firestore = await tool.execute(
      { method: 'explainDenial', args: { operation: 'get', path: 'a/b', source: FILE_TEXT } },
      ctx,
    );
    expect(firestore.ok).toBe(false);
  });

  it('explains a multi-path update as the request it was', async () => {
    const { data } = await explain(
      { rooms: { $roomId: { '.write': "$roomId == 'r1'" } } },
      {
        operation: 'update',
        path: '/',
        uid: 'bob',
        data: { 'rooms/r1/title': 'x', 'rooms/r2/title': 'y' },
      },
    );
    expect(data.allowed).toBe(false);
    expect(data.case).toMatchObject({
      operation: 'update',
      ruleKind: 'write',
      why: 'evaluated-false',
      matchedPath: '/rooms/$roomId',
      bindings: { $roomId: 'r2' },
    });
  });

  it('explains a query-gated read with the query it carried', async () => {
    const rules = { notes: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" } };
    const denied = await explain(rules, {
      operation: 'read',
      path: 'notes',
      uid: 'bob',
      query: { orderByChild: 'owner', equalTo: 'alice' },
    });
    expect(denied.data.allowed).toBe(false);
    expect(denied.data.case.why).toBe('evaluated-false');
    const allowed = await explain(rules, {
      operation: 'read',
      path: 'notes',
      uid: 'bob',
      query: { orderByChild: 'owner', equalTo: 'bob' },
    });
    expect(allowed.data.allowed).toBe(true);
  });

  // `rules.set` refuses a rule the simulator cannot parse, as production's deploy
  // does, so no ruleset loaded that way reaches this verdict. Rules installed
  // through the sandbox API are not gated, and the engine still abstains on them.
  it('reports a rule the simulator cannot evaluate as unsupported', async () => {
    const { data } = await explain(
      { rooms: { '.write': 'auth.uid ===' } },
      { operation: 'write', path: 'rooms/r1', uid: 'bob', data: 1 },
      true,
    );
    expect(data.allowed).toBe(false);
    expect(data.case.why).toBe('unsupported');
    expect(data.case.trace.map((entry) => entry.verdict)).toEqual(['UNSUPPORTED']);
    expect(data.case.fix).toBeUndefined();
  });

  it('refuses a draft production would refuse at deploy, with the load message', async () => {
    const draft = JSON.stringify({ rules: { rooms: { '.write': 'auth.uid ===' } } });
    const { result } = await explain(
      { rooms: { '.write': true } },
      { operation: 'write', path: 'rooms/r1', uid: 'bob', data: 1, rules: draft },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('did not compile');
    expect(result.data).toMatchObject({ code: 'invalid_arguments', field: 'rules' });
  });

  it('describes every request method the database accepts, update included', () => {
    const description = explainDenial.args.shape.operation.description ?? '';
    for (const method of DATABASE_RULES.requestMethods) expect(description).toContain(method);
    expect(description).toContain('update');
  });

  it('binds every $wildcard on a nested path', async () => {
    const { data } = await explain(
      {
        games: {
          $gameId: {
            players: { $uid: { '.read': true, '.write': 'auth.uid == $uid' } },
          },
        },
      },
      { operation: 'write', path: 'games/g1/players/alice', uid: 'bob', data: { score: 1 } },
    );
    expect(data.case).toMatchObject({
      matchedPath: '/games/$gameId/players/$uid',
      why: 'evaluated-false',
      bindings: { $gameId: 'g1', $uid: 'alice' },
    });
  });

  it('says an unauthenticated request needs an identity', async () => {
    const { data } = await explain(
      { notes: { '.read': 'auth != null' } },
      { operation: 'read', path: 'notes/n1', uid: undefined },
    );
    expect(data.allowed).toBe(false);
    expect(data.case.why).toBe('evaluated-false');
    expect(data.case.fix).toContain('authenticated');
  });

  it('explains an allowed request by its deciding rule', async () => {
    const { result, data } = await explain(
      { notes: { '.read': true } },
      { operation: 'read', path: 'notes/n1' },
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('is allowed');
    expect(data.allowed).toBe(true);
    expect(data.case).toMatchObject({ decision: 'ALLOW', matchedPath: '/notes', ruleKind: 'read' });
  });

  it('refuses a Firestore method for the database and a service with no trace', async () => {
    const wrongMethod = await explain({ '.read': true }, { operation: 'get', path: 'a' });
    expect(wrongMethod.result.ok).toBe(false);
    const ctx = createSurfaceContext(initializeSandbox());
    const tool = surface.tools.find((candidate) => candidate.name === 'rules')!;
    const storage = await tool.execute(
      { method: 'explainDenial', args: { service: 'storage', operation: 'read', path: 'a' } },
      ctx,
    );
    expect(storage.ok).toBe(false);
  });
});
