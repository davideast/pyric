/**
 * H2 candidate (ST-H2-8, NEEDS_RUNTIME_MRE). Does production accept a
 * `service firebase.storage` with two top-level `match /b/.../o` blocks, one
 * per bucket? pyric's shared grammar (`ServiceBlock = "service" name "{"
 * FunctionDef* DocumentsMatch FunctionDef* "}"`) takes exactly one, so
 * `parseStorageRules` throws `expected "}" or "function"` at the second block,
 * and the dev server refuses to serve the file.
 *
 * If the capture returns verdicts, production compiled the source and pyric
 * refuses a deployable ruleset (deploy-time divergence, severity 3). If the
 * API rejects the source, pyric is right and this finding is FALSE.
 *
 * pyric decides: source rejected at parse (no verdicts).
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H2-TWO-TOP-LEVEL-MATCHES',
  rationale: 'Whether production compiles one Storage ruleset with a top-level match block per bucket.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/demo-pyric.appspot.com/o {
    match /{f=**} { allow read: if true; }
  }
  match /b/{bucket}/o {
    match /{f=**} { allow read: if false; }
  }
}`,
  cases: [
    { description: 'named bucket block grants get', expectation: 'ALLOW', method: 'get', path: 'a.bin', bucket: 'demo-pyric.appspot.com', existingResource: { size: 1 } },
    { description: 'other bucket falls to the wildcard block', expectation: 'DENY', method: 'get', path: 'a.bin', bucket: 'other-bucket', existingResource: { size: 1 } },
  ],
};
