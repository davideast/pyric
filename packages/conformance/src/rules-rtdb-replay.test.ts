import { expect, test } from 'bun:test';
import { ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';
import { replayRtdbScenario, traceAgreesWithVerdict } from './rules-rtdb-replay.ts';

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
