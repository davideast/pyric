import type { RigManifestRecord } from './types.ts';

/**
 * The Storage rules oracle (`scripts/oracle/run-rules-storage.ts`). Sibling
 * of the Firestore rules rig for the `service firebase.storage` surface —
 * replays the storage rules conformance corpus
 * (`scripts/oracle/rules-corpus/storage/`) against the SAME production Rules
 * Test API (`projects.test`, confirmed to accept Storage rulesets) and
 * captures a per-case verdict table as `rules-storage-` observations. Without
 * PARITY_SA_BASE64 the runner makes no network calls at all — it prints the
 * capture plan and exits 0.
 */
export const rig: RigManifestRecord = {
  description:
    'Replays the Storage rules conformance corpus against the production Rules Test API (the same projects.test endpoint the Firestore rig uses); captures a per-case ALLOW/DENY/UNSUPPORTED verdict table as rules-storage- observations.',
  script: 'scripts/oracle/run-rules-storage.ts',
  observationPrefixes: ['rules-storage-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PARITY_SA_BASE64',
        description:
          'Base64-encoded service-account JSON scoped to firebaserules.rulesets.test only — the identical credential contract as the Firestore rules rig. The project the service account belongs to is the project rules are tested against.',
        permission: 'firebaserules.rulesets.test',
      },
    ],
    projectFeatures: [],
    local: [],
  },
  safety: {
    writes:
      'None — the Rules Test API only evaluates rules against synthetic requests defined by the corpus; it does not mutate Storage data.',
    cleanup: 'Not applicable; the rig performs no mutation to clean up.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by scripts/oracle/check-observation-versions.ts against the installed node_modules/firebase/package.json version, for the same consistency reason as the Firestore rules rig.',
  },
};
