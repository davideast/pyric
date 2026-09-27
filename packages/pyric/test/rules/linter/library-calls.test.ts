/**
 * EXPRESSION_LIBRARY_CALLS: the informational finding that lists the three
 * most expensive standard library calls in each rule.
 *
 * `fixtures/library-calls/arcade.rules` is the resolved Firestore ruleset of
 * the arcade repository (`app/firestore.rules` at commit
 * 1b8389d891bff9b33e8f92c957df740fb90726d1), an externally authored ruleset
 * that imports the lobby, turns, state and lifecycle modules and resolves
 * them with the modules resolver.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { ruleLibraryCalls } from '../../../src/rules/linter/library-calls.js';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';
import { resolveModulesBrowser } from '../../../src/rules/modules/resolver-browser.js';

const ARCADE = readFileSync(join(import.meta.dir, 'fixtures', 'library-calls', 'arcade.rules'), 'utf8');

describe('EXPRESSION_LIBRARY_CALLS on the arcade ruleset', () => {
  const findings = lintFirestoreRules(ARCADE).warnings.filter((w) => w.rule === 'EXPRESSION_LIBRARY_CALLS');

  it('reports every rule that calls the library, as info', () => {
    expect(findings).toHaveLength(42);
    expect(new Set(findings.map((f) => f.severity))).toEqual(new Set(['info']));
  });

  it('lists the three most expensive calls with their measured cost per call and call count', () => {
    const move = findings.find((f) => f.location?.ruleIndex === 4)!;
    expect(move.location?.matchPath).toBe('/tictactoe/{matchId}');
    expect(move.message).toBe(
      "Rule #4 in '/tictactoe/{matchId}' spends most on these library calls: isMyTurn (turns): 1 call, 16 to 23 expressions per call; turnFlipped (turns): 1 call, 15 to 22 expressions per call; moveIncremented (state): 1 call, 11 expressions per call. Calls are not memoized: each call pays again.",
    );
    // The fourth library call in the rule, isPlaying, is cheaper and left out.
    const calls = ruleLibraryCalls(parseToAST(ARCADE)!).find((r) => r.ruleIndex === 4)!.calls;
    expect(calls.map((c) => c.name)).toEqual(['isMyTurn', 'turnFlipped', 'moveIncremented', 'isPlaying']);
  });

  it('attributes calls reached through project functions to the library', () => {
    // ticTacToeJoin() calls validJoin() and onlyFieldsChanged().
    const join = findings.find((f) => f.location?.ruleIndex === 3)!;
    expect(join.message).toContain('validJoin (lobby): 1 call, 10 to 57 expressions per call');
    expect(join.message).toContain('onlyFieldsChanged (lifecycle): 1 call, 10 expressions per call');
  });

  it('does not change the warnings and errors', () => {
    const others = lintFirestoreRules(ARCADE).warnings.filter((w) => w.rule !== 'EXPRESSION_LIBRARY_CALLS');
    expect(others.every((w) => w.severity !== 'info')).toBe(true);
  });
});

describe('EXPRESSION_LIBRARY_CALLS on small rulesets', () => {
  function resolved(source: string): string {
    const r = resolveModulesBrowser(source);
    if (!r.success) throw new Error(r.error.message);
    return r.data.resolved;
  }

  it('counts every call: calls are not memoized', () => {
    const source = resolved(`rules_version = '2+modules';
import { isOwner } from 'auth';
service cloud.firestore {
  match /databases/{database}/documents {
    function ownsBoth() { return isOwner(resource.data.a) && isOwner(resource.data.b); }
    match /pairs/{id} {
      allow update: if ownsBoth() || isOwner(resource.data.admin);
    }
  }
}`);
    const [finding] = lintFirestoreRules(source).warnings.filter((w) => w.rule === 'EXPRESSION_LIBRARY_CALLS');
    expect(finding!.message).toContain('isOwner (auth): 3 calls, 7 to 13 expressions per call');
    // isOwner calls isAuthenticated, so each of the three calls makes one.
    expect(finding!.message).toContain('isAuthenticated (auth): 3 calls, 5 expressions per call');
  });

  it('ignores a project function that shares a library name but not its body', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  function isAuthenticated() { return request.auth != null && request.auth.token.email_verified == true; }
  match /databases/{database}/documents {
    match /posts/{id} {
      allow read: if isAuthenticated();
    }
  }
}`;
    expect(lintFirestoreRules(source).warnings.filter((w) => w.rule === 'EXPRESSION_LIBRARY_CALLS')).toEqual([]);
  });

  it('reports nothing for a rule without library calls', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow read: if request.auth != null; }
  }
}`;
    expect(lintFirestoreRules(source).warnings).toEqual([]);
  });
});
