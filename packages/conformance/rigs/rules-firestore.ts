import type { RigManifestRecord } from './types.ts';

/**
 * The Firestore rules oracle (`packages/conformance/src/run-rules.ts`). Replays the
 * Firestore rules conformance corpus (`packages/conformance/rules-corpus/firestore/`)
 * against the production Firestore Rules Test API and captures a per-case
 * ALLOW/DENY/UNSUPPORTED verdict table as `rules-firestore-` observations.
 * Without a credential the runner makes no network calls at all; it prints
 * the capture plan and exits 0 (see the script's header comment).
 */
export const rig: RigManifestRecord = {
  description:
    'Replays the Firestore rules conformance corpus against the production Firestore Rules Test API; captures a per-case ALLOW/DENY/UNSUPPORTED verdict table as rules-firestore- observations.',
  script: 'packages/conformance/src/run-rules.ts',
  observationPrefixes: ['rules-firestore-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'GOOGLE_APPLICATION_CREDENTIALS',
        description:
          'Application Default Credentials file for an identity scoped to firebaserules.rulesets.test only. CI writes it through Workload Identity Federation. Without it the runner uses a firebase-tools login or the gcloud ADC file. PARITY_PROJECT_ID names the project rules are tested against.',
        permission: 'firebaserules.rulesets.test',
      },
    ],
    projectFeatures: [],
    local: [],
  },
  safety: {
    writes:
      'None — the Rules Test API only evaluates rules against synthetic requests defined by the corpus; it does not mutate Firestore data.',
    cleanup: 'Not applicable; the rig performs no mutation to clean up.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase/package.json version. The Rules Test API has no client SDK of its own, but the envelope carries fbSdkVersion for consistency with the rest of the oracle and to keep the version guard green once captures land.',
  },
};
