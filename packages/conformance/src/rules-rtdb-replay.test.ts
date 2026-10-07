import { expect, test } from 'bun:test';
import { ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';
import { replayRtdbDeployScenario, replayRtdbScenario, traceAgreesWithVerdict } from './rules-rtdb-replay.ts';
test('replays one RTDB corpus scenario through the local simulator', () => {
  const scenario = ALL_RULES_RTDB_SCENARIOS.find((candidate) => candidate.id === 'r1-auth-only');
  expect(scenario).toBeDefined();
  if (!scenario) return;

  expect(replayRtdbScenario(scenario)).toEqual([
    {
      caseKey: 'authed read allowed',
      production: 'ALLOW',
      simulator: 'ALLOW',
    },
    {
      caseKey: 'authed write allowed',
      production: 'ALLOW',
      simulator: 'ALLOW',
    },
    {
      caseKey: 'anon read denied',
      production: 'DENY',
      simulator: 'DENY',
    },
    {
      caseKey: 'anon write denied',
      production: 'DENY',
      simulator: 'DENY',
    },
  ]);
});

test('applies mount-relative seed data before replaying a case', () => {
  expect(replayRtdbScenario({
    id: 'seeded-replay',
    fm: 'rtdb#71',
    rationale: 'A sibling membership lookup sees pre-existing data.',
    provenance: 'Synthetic replay-adapter specification.',
    rules: JSON.stringify({
      rooms: {
        r1: {
          members: {},
          messages: {
            $messageId: {
              '.write': "auth != null && data.parent().parent().child('members').hasChild(auth.uid)",
            },
          },
        },
      },
    }),
    cases: [
      {
        description: 'member write sees the seeded sibling membership',
        expectation: 'ALLOW',
        operation: 'write',
        opPath: '/rooms/r1/messages/m1',
        authPresent: true,
        seed: { '/rooms/r1/members/<UID>': true },
        newData: { text: 'hello' },
      },
    ],
  })).toEqual([
    {
      caseKey: 'member write sees the seeded sibling membership',
      production: 'ALLOW',
      simulator: 'ALLOW',
    },
  ]);
});

test('reports an engine error and an abstention apart from a DENY', () => {
  const results = replayRtdbScenario({
    id: 'outcome-replay',
    fm: 'rtdb#71',
    rationale: 'An engine error or abstention never reads as a production DENY.',
    provenance: 'Synthetic replay-adapter specification.',
    rules: JSON.stringify({
      outside: { '.write': 'auth != null', '.validate': 'newData.val().trim() == newData.val()' },
      unparseable: { '.write': 'newData.val(' },
      runtime: { '.write': 'auth != null', '.validate': "newData.val().toUpperCase() == 'OK'" },
    }),
    cases: [
      { description: 'method outside the rules language', expectation: 'DENY', operation: 'write', opPath: '/outside', authPresent: true, newData: 'x' },
      { description: 'method outside the rules language, in an update', expectation: 'DENY', operation: 'update', opPath: '/', authPresent: true, newData: { outside: 'x' } },
      { description: 'unparseable rule', expectation: 'DENY', operation: 'write', opPath: '/unparseable', authPresent: true, newData: 'x' },
      { description: 'runtime error', expectation: 'DENY', operation: 'write', opPath: '/runtime', authPresent: true, newData: 5 },
    ],
  });
  expect(results.map((result) => result.simulator)).toEqual(['ERROR', 'ERROR', 'UNSUPPORTED', 'DENY']);
});

test('a result whose trace does not account for its verdict is not a verdict', () => {
  const grant = { path: '/', kind: 'write' as const, conditionText: 'true', verdict: 'ALLOW' as const, pathVariableBindings: {} };
  const refusal = { path: '/a', kind: 'validate' as const, conditionText: 'false', verdict: 'DENY' as const, pathVariableBindings: {} };
  const base = { matchedPath: '/', matchedRule: 'true', reason: '', pathVariableBindings: {} };
  expect(traceAgreesWithVerdict({ ...base, allowed: true, trace: [grant] })).toBe(true);
  expect(traceAgreesWithVerdict({ ...base, allowed: false, trace: [grant, refusal] })).toBe(true);
  expect(traceAgreesWithVerdict({ ...base, allowed: true, trace: [grant, refusal] })).toBe(false);
  expect(traceAgreesWithVerdict({ ...base, allowed: false, trace: [grant] })).toBe(false);
  expect(traceAgreesWithVerdict({ ...base, allowed: true, trace: [] })).toBe(false);
});

test('replays query and custom-claim cases through the simulator', () => {
  const results = replayRtdbScenario({
    id: 'query-claims-replay',
    fm: 'rtdb#71',
    rationale: 'Query fields and token claims reach the rules.',
    provenance: 'Synthetic replay-adapter specification.',
    rules: JSON.stringify({
      items: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" },
      admin: { '.write': 'auth.token.admin == true' },
      provider: { '.write': "auth.token.firebase.sign_in_provider == 'custom'" },
    }),
    cases: [
      { description: 'owner query', expectation: 'ALLOW', operation: 'query', opPath: '/items', authPresent: true, query: { orderByChild: 'owner', equalTo: '<UID>' } },
      { description: 'plain read', expectation: 'DENY', operation: 'read', opPath: '/items', authPresent: true },
      { description: 'admin claim', expectation: 'ALLOW', operation: 'write', opPath: '/admin', authPresent: true, claims: { admin: true }, newData: 1 },
      { description: 'anonymous has no claim', expectation: 'DENY', operation: 'write', opPath: '/admin', authPresent: true, newData: 1 },
      { description: 'custom-token provider', expectation: 'ALLOW', operation: 'write', opPath: '/provider', authPresent: true, claims: {}, newData: 1 },
    ],
  });
  expect(results.map((result) => [result.caseKey, result.simulator])).toEqual([
    ['owner query', 'ALLOW'],
    ['plain read', 'DENY'],
    ['admin claim', 'ALLOW'],
    ['anonymous has no claim', 'DENY'],
    ['custom-token provider', 'ALLOW'],
  ]);
});

test('replays deploy cases through the local ruleset check', () => {
  const results = replayRtdbDeployScenario({
    id: 'deploy-replay',
    fm: 'rtdb#71',
    rationale: 'Local load-time checks against production deploy verdicts.',
    provenance: 'Synthetic replay-adapter specification.',
    deployCases: [
      {
        description: 'valid',
        construct: 'rtdb.rule-kind.read',
        rules: JSON.stringify({ a: { '.read': 'auth != null' } }),
        expectation: { verdict: 'ACCEPTED' },
      },
      {
        description: 'unknown variable',
        construct: 'rtdb.binding.unknown-variable',
        rules: JSON.stringify({ a: { '.read': 'foo == 1' } }),
        expectation: { verdict: 'REJECTED', error: "Unknown variable 'foo'." },
      },
    ],
  });
  expect(results).toEqual([
    { caseKey: 'valid', construct: 'rtdb.rule-kind.read', production: 'ACCEPTED', local: 'ACCEPTED', localErrors: [] },
    {
      caseKey: 'unknown variable',
      construct: 'rtdb.binding.unknown-variable',
      production: 'REJECTED',
      local: 'REJECTED',
      localErrors: [expect.stringContaining('foo')],
    },
  ]);
});
