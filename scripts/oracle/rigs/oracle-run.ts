import type { RigManifestRecord } from './types.ts';

/**
 * The primary Web SDK oracle (`scripts/oracle/run.ts`). Probes bare upstream
 * `firebase/auth`, `firebase/firestore`, `firebase/database`, and
 * `firebase/storage` against a dedicated real Firebase project and captures
 * production behavior as `auth-`, `firestore-`, `rtdb-`, `rtdb-modular-`, and
 * `storage-` observations. See `scripts/oracle/README.md` for the one-time
 * project setup this rig assumes.
 */
export const rig: RigManifestRecord = {
  description:
    'Probes bare upstream firebase/auth, firebase/firestore, firebase/database, and firebase/storage against a dedicated real Firebase project; captures production behavior as auth-, firestore-, rtdb-, rtdb-modular-, and storage- observations.',
  script: 'scripts/oracle/run.ts',
  observationPrefixes: ['auth-', 'firestore-', 'rtdb-', 'rtdb-modular-', 'storage-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Web SDK config JSON (apiKey/authDomain/projectId/…) for the dedicated oracle Firebase project. Alternative credential path to PYRIC_ORACLE_SA_PATH — either one satisfies the harness, this one skips the service-account token mint.',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Path to a service-account JSON. The harness mints a short-lived OAuth token from it and calls the Firebase Management API to fetch the Web SDK config automatically. Optional: defaults to ignored/service-account.json when unset, and is not needed at all if PYRIC_ORACLE_FIREBASE_CONFIG is provided instead.',
      },
    ],
    projectFeatures: [
      'Anonymous sign-in enabled (Authentication → Sign-in method → Anonymous).',
      'Firestore rules scoped to the pyric_oracle namespace (see scripts/oracle/README.md for the exact rules snippet).',
      'RTDB instance provisioned with rules permitting anonymous access under /pyric_oracle/* — optional: RTDB probes self-skip with { skipped: true, reason: "no rtdb instance on project" } when the project has no instance.',
      'Storage bucket present — optional: the rules deploy is best-effort, and probes observe whatever rules already exist if the deploy fails.',
    ],
    local: [],
  },
  safety: {
    writes:
      'Test docs/users/objects under the pyric_oracle namespace in the dedicated oracle Firebase project (Firestore, RTDB, Storage) plus anonymous Auth users.',
    cleanup:
      'Each probe writes under a unique run-scoped sub-collection and deletes its own docs and anonymous user on the way out; a failed probe still attempts a best-effort purge. One documented leak: the auth-signout-idempotent probe deliberately ends signed out, so its anonymous user cannot be deleted from the client SDK afterward (see scripts/oracle/README.md).',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by scripts/oracle/check-observation-versions.ts against the installed node_modules/firebase/package.json version.',
  },
};
