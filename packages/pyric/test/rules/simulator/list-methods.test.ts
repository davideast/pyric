/**
 * List methods in the Firestore simulator and the Storage evaluator.
 *
 * `List.concat()` and `List.removeAll()` live in one module
 * (src/rules/simulator/list-methods.ts) that both evaluators call. The cases
 * are the `list:` cases of the Storage corpus scenario
 * `upload-primitives-boundaries`, which production evaluated over the Rules
 * Test API; its diagnostics carry the error text production reported for
 * each error case.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../../../conformance/rules-corpus/storage/index.ts';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

const SCENARIO_ID = 'upload-primitives-boundaries';
const scenario = ALL_RULES_STORAGE_SCENARIOS.find((s) => s.id === SCENARIO_ID)!;
const observation = JSON.parse(readFileSync(join(
  import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'storage-rules',
  `rules-storage-${SCENARIO_ID}.json`,
), 'utf8')) as {
  behavior: Record<string, 'ALLOW' | 'DENY'>;
  diagnostics: Record<string, { notes?: string[] }>;
};

/** Each `list:` case with its allow condition, read from the scenario's match block. */
const LIST_CASES = scenario.cases
  .filter((c) => c.description.startsWith('list: '))
  .map((c) => {
    const folder = c.path.split('/')[0]!;
    const match = new RegExp(`match /${folder}/\\{fileName\\} \\{\\s*allow create: if (.*);`).exec(scenario.rules);
    if (!match) throw new Error(`no match block for ${folder}`);
    const note = observation.diagnostics[c.description]?.notes?.[0];
    // Production prefixes its message with the rule's line and column.
    const message = note?.replace(/^Error: storage\.rules line \[\d+\], column \[\d+\]\. /, '');
    return { description: c.description, condition: match[1]!, verdict: observation.behavior[c.description]!, message };
  });

const handler = new SimulateFirestoreRulesHandler();

function firestore(condition: string) {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} { allow get: if ${condition}; }
  }
}`;
  const result = handler.simulate(source, [{
    description: 'list', expectation: 'ALLOW', method: 'get', path: 't/x', auth: { uid: 'u' }, resource: { a: 1 },
  }]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

function storage(condition: string) {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /t/{file} { allow create: if ${condition}; }
  }
}`);
  return evaluateStorageRules(rules, {
    request: {
      auth: { uid: 'u' },
      method: 'create',
      path: '/b/pyric-default/o/t/x',
      resource: { size: 1, metadata: { a: 'x', b: 'y' } },
    },
    resource: null,
  });
}

describe('List methods in Storage, cases production evaluated', () => {
  test('the scenario has its List-method cases', () => {
    expect(LIST_CASES.length).toBe(52);
  });
  for (const { description, condition, verdict, message } of LIST_CASES) {
    test(`${description}: ${verdict}`, () => {
      const result = storage(condition);
      expect(result.allowed ? 'ALLOW' : 'DENY').toBe(verdict);
      if (message !== undefined) expect(result.reasons.join(' ')).toContain(message);
    });
  }
});

describe('concat() and removeAll() are one implementation in both evaluators', () => {
  // The cases on a List literal: Firestore has no custom metadata to call
  // keys() on, and a receiver that is not a List never reaches the module.
  const shared = LIST_CASES.filter(({ description, condition }) =>
    /^list: (concat|removeAll):/.test(description) && !description.includes('receiver')
      && !condition.includes('request.resource'));

  test('the List-literal concat and removeAll cases are present', () => {
    expect(shared.length).toBe(10);
  });
  for (const { description, condition, verdict, message } of shared) {
    test(`${description}: Firestore ${verdict}`, () => {
      const result = firestore(condition);
      expect(result.decision).toBe(verdict);
      if (message !== undefined) expect(result.trace.map((step) => step.message).join(' ')).toContain(message);
    });
  }
});
