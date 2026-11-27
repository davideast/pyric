import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULES_FIRESTORE_SCENARIOS,
  FIX_CLASS_SCENARIOS,
  STRESS_SCENARIOS,
  observationName,
} from '../../../rules-corpus/firestore/index.ts';
import { firestoreScenarioRecordProblems } from '../../../rules-corpus/firestore/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', '..', '..', 'observations', 'firestore-rules');

function record(description: string, expectation: 'ALLOW' | 'DENY', extras: Record<string, unknown> = {}) {
  return {
    fm: 'test', rationale: 'test', rules: 'service cloud.firestore {}', group: 'stress',
    ...extras,
    cases: [{ description, expectation, method: 'get', path: 'x/y' }],
  };
}

describe('Firestore rules corpus validation', () => {
  it('rejects a description that contradicts its authored expectation', () => {
    expect(firestoreScenarioRecordProblems('test.ts', 'test', record('behavior ALLOW', 'DENY')))
      .toEqual([expect.stringContaining("description contradicts expectation 'DENY'")]);
  });

  it('accepts a matching verdict word', () => {
    expect(firestoreScenarioRecordProblems('test.ts', 'test', record('behavior DENY', 'DENY'))).toEqual([]);
  });

  it('validates realDatabaseOnly as an optional boolean', () => {
    expect(firestoreScenarioRecordProblems('test.ts', 'test', record('ok', 'ALLOW', { realDatabaseOnly: true })))
      .toEqual([]);
    expect(firestoreScenarioRecordProblems('test.ts', 'test', record('ok', 'ALLOW', { realDatabaseOnly: 'yes' })))
      .toEqual([expect.stringContaining("'realDatabaseOnly' must be a boolean when present")]);
  });

  it('excludes realDatabaseOnly scenarios from live Rules Test API parity packs while keeping them in ALL_RULES_FIRESTORE_SCENARIOS', () => {
    const allIds = new Set(ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id));
    const stressIds = new Set(STRESS_SCENARIOS.map((s) => s.id));
    const fixIds = new Set(FIX_CLASS_SCENARIOS.map((s) => s.id));

    expect(allIds.has('atomic-batch-sibling-merge')).toBe(true);
    expect(allIds.has('get-after-and-exists-after')).toBe(true);
    expect(fixIds.has('atomic-batch-sibling-merge')).toBe(false);
    expect(stressIds.has('get-after-and-exists-after')).toBe(false);
  });

  it('every live Rules Test API parity pack case expectation matches its committed production observation verdict', () => {
    const mismatches: string[] = [];
    for (const scenario of [...STRESS_SCENARIOS, ...FIX_CLASS_SCENARIOS]) {
      const obsPath = join(OBS_DIR, `${observationName(scenario)}.json`);
      if (!existsSync(obsPath)) continue;
      const obs = JSON.parse(readFileSync(obsPath, 'utf8')) as { behavior?: Record<string, unknown> };
      for (const tc of scenario.cases) {
        const prod = obs.behavior?.[tc.description];
        if ((prod === 'ALLOW' || prod === 'DENY') && prod !== tc.expectation) {
          mismatches.push(`${scenario.id} :: ${tc.description} (expected=${tc.expectation}, prod=${prod})`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
