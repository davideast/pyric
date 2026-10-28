/**
 * ─── Candidate scenario (hunt H1, ST-H1-5 deploy half): h1-in-is-precedence-deploy ─
 * Rules that the documented precedence table makes valid (`in` and `is` are
 * left-associative and bind tighter than `==`) but that pyric's shared
 * grammar refuses to parse ("expected ';' after the allow statement").
 * If production compiles this ruleset, pyric rejects a deployable ruleset.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-IN-IS-PRECEDENCE-DEPLOY',
  rationale: 'Chained or compared in/is expressions are valid under the documented precedence and rejected by pyric at parse.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /prec/is-eq.bin { allow create: if request.resource.size is int == true; }
    match /prec/in-is.bin { allow create: if 'a' in ['a'] is bool; }
    match /prec/in-in.bin { allow create: if 'a' in ['a'] in [true]; }
    match /prec/is-is.bin { allow create: if 1 is int is bool; }
  }
}`,
  cases: [
    { description: 'is then ==: size is int == true (pyric parse error)', expectation: 'ALLOW', method: 'create', path: 'prec/is-eq.bin', resource: { size: 1 } },
    { description: 'in then is: (a in list) is bool (pyric parse error)', expectation: 'ALLOW', method: 'create', path: 'prec/in-is.bin', resource: { size: 1 } },
    { description: 'in then in: (a in list) in [true] (pyric parse error)', expectation: 'ALLOW', method: 'create', path: 'prec/in-in.bin', resource: { size: 1 } },
    { description: 'is then is: (1 is int) is bool (pyric parse error)', expectation: 'ALLOW', method: 'create', path: 'prec/is-is.bin', resource: { size: 1 } },
  ],
};
