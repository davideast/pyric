/**
 * Oracle conformance: Storage rules.
 *
 * The Storage counterpart of test/rules/oracle-conformance.test.ts. It replays
 * every `packages/conformance/observations/storage-rules/rules-storage-*.json`
 * capture against the in-process Storage evaluator through the same replay the
 * scorecard uses (`replayStorageRulesObservations`), so the test command and the
 * published score cannot disagree about replay semantics.
 *
 * A case where the evaluator disagrees with production is pinned as one file in
 * `packages/conformance/storage-rules-exceptions/`, naming both verdicts and the
 * finding. A scenario production accepts but pyric refuses to parse is pinned by
 * its observation name with the parse error pyric reports. Each pin fails the
 * moment either side moves, and an unused pin fails as stale.
 */
import { describe, expect, it } from 'bun:test';
import { ALL_RULES_STORAGE_SCENARIOS, storageObservationName } from '../../../../packages/conformance/rules-corpus/storage/index.ts';
import {
  replayStorageRulesObservations,
  storageParsePins,
} from '../../../../packages/conformance/src/storage-rules-oracle-replay.ts';
import { parseStorageRules } from '../../src/storage/sandbox/rules.ts';

const replays = replayStorageRulesObservations();
const parsePins = storageParsePins();

function parseError(rules: string): string | undefined {
  try {
    parseStorageRules(rules);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('oracle conformance (rules-storage)', () => {
  // Corpus sanity: every scenario parses unless its capture pins pyric's refusal.
  it('every storage corpus scenario parses or carries a parse pin', () => {
    for (const scenario of ALL_RULES_STORAGE_SCENARIOS) {
      const pinnedError = parsePins.get(storageObservationName(scenario));
      const error = parseError(scenario.rules);
      if (pinnedError === undefined) {
        expect(error, `scenario "${scenario.id}" must parse`).toBeUndefined();
        continue;
      }
      expect(error, `scenario "${scenario.id}" is pinned as a parse divergence`).toContain(pinnedError);
    }
  });

  for (const replay of replays) {
    it(`${replay.name}: evaluator matches captured production verdicts`, () => {
      expect(replay.problems).toEqual([]);
    });
  }
});
