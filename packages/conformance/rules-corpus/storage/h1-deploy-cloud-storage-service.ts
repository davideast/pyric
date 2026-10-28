/**
 * ─── Candidate scenario (hunt H1, ST-H1-12): h1-deploy-cloud-storage-service ──
 * The Storage docs' version 2 opt-in snippet names the service `cloud.storage`:
 * "rules_version = '2'; service cloud.storage { match /b/{bucket}/o { ... } }"
 * (https://firebase.google.com/docs/storage/security/core-syntax). pyric's
 * parseStorageRules rejects any service other than firebase.storage
 * ("Expected 'service firebase.storage', got 'service cloud.storage'").
 * Records whether production compiles and evaluates the documented name.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-DEPLOY-SERVICE-NAME',
  rationale: 'The documented cloud.storage service name is rejected by pyric.',
  rules: `rules_version = '2';
service cloud.storage {
  match /b/{bucket}/o {
    match /svc/{f} { allow read: if true; }
  }
}`,
  cases: [
    { description: 'cloud.storage service grants read (pyric parse error)', expectation: 'ALLOW', method: 'get', path: 'svc/a.txt' },
  ],
};
