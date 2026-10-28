/**
 * The production behavior each RTDB security lint finding states, pinned to
 * the captured production verdicts it rests on. A finding's message is a
 * claim about production (a deeper `false` does not revoke an ancestor grant,
 * a delete skips `.validate`, an unnamed key runs no `.validate`); if a
 * recapture ever changed one of these verdicts, the finding would be wrong
 * and this test fails first.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileRtdbRules } from '../../pyric/src/rules/rtdb/compiled-rules.ts';
import {
  lintRtdbRuleset,
  type RtdbSecurityCode,
} from '../../pyric/src/rules/rtdb/grammar/ruleset-lint.ts';
import { ALL_RULES_RTDB_SCENARIOS, rtdbObservationName } from '../rules-corpus/rtdb/index.ts';

const OBSERVATIONS = join(import.meta.dir, '..', 'observations', 'rtdb-rules');

function scenario(id: string) {
  const found = ALL_RULES_RTDB_SCENARIOS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no RTDB corpus scenario ${id}`);
  return found;
}

/** The production verdict the capture recorded for one case of a scenario. */
function production(id: string, description: string): string {
  const path = join(OBSERVATIONS, `${rtdbObservationName(scenario(id))}.json`);
  const observation = JSON.parse(readFileSync(path, 'utf8')) as { behavior: Record<string, string> };
  const verdict = observation.behavior[description];
  if (verdict === undefined) throw new Error(`${id} has no recorded case "${description}"`);
  return verdict;
}

/** The paths at which the lint reports `code` on a scenario's ruleset. */
function reported(id: string, code: RtdbSecurityCode): string[] {
  const rules = JSON.parse(scenario(id).rules) as Record<string, unknown>;
  return lintRtdbRuleset(compileRtdbRules({ rules }))
    .filter((finding) => finding.code === code)
    .map((finding) => finding.path);
}

describe('RTDB security lint claims match captured production verdicts', () => {
  test('RTDB-SEC-4: a deeper .write false does not revoke an ancestor .write grant', () => {
    expect(production('r5-cascade-root-grant', 'deeper false override write denied (BUT cascade from auth grant?)')).toBe('ALLOW');
    expect(reported('r5-cascade-root-grant', 'RTDB-SEC-4')).toEqual(['/inner']);
  });

  test('RTDB-SEC-2: a .read of true grants a signed-out client every path below it', () => {
    expect(production('r5-cascade-root-grant', 'cascade allows anon deep read (true)')).toBe('ALLOW');
    expect(reported('r5-cascade-root-grant', 'RTDB-SEC-2')).toEqual(['/']);
  });

  test('RTDB-SEC-5: a delete of a node with a .validate rule does not run it', () => {
    expect(production('r21-validate-on-delete', 'writing null deletes the node')).toBe('ALLOW');
    expect(production('r21-validate-on-delete', 'writing an empty object deletes the node')).toBe('ALLOW');
    // A transition rule on a node whose .write never reads newData is the
    // shape the finding names.
    expect(reported('r23-validate-sibling-scope', 'RTDB-SEC-5')).toEqual(['/rooms/$room/count']);
  });

  test('RTDB-SEC-7: a key no rule names runs no .validate, and $other false rejects it', () => {
    expect(production('r15-validate-ancestor-scope', 'write at the validated node satisfying its rule allowed (control)')).toBe('ALLOW');
    expect(reported('r15-validate-ancestor-scope', 'RTDB-SEC-7')).toEqual(['/p1']);
    expect(production('r19-literal-and-wildcard-siblings', 'wildcard validate runs for another key')).toBe('DENY');
    expect(reported('r19-literal-and-wildcard-siblings', 'RTDB-SEC-7')).toEqual([]);
  });

  test('RTDB-SEC-1 folds X || true as not constant: an error on the left of || fails the rule', () => {
    expect(production('r26-rule-runtime-error', 'error on the left of || with a true right side')).toBe('DENY');
    expect(lintRtdbRuleset(compileRtdbRules({
      rules: { a: { '.write': "newData.val().toUpperCase() == 'OK' || true" } },
    })).filter((finding) => finding.code === 'RTDB-SEC-1')).toEqual([]);
  });
});
