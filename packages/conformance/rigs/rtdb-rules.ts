import type { RigManifestRecord } from './types.ts';

/**
 * The RTDB rules oracle (`packages/conformance/src/run-rules-rtdb.ts`). The
 * last rules engine to get a corpus, and the only one whose production truth
 * cannot be read from a server-side rules test API: Realtime Database has NO
 * `firebaserules projects.test` equivalent. So this rig captures the way the
 * `rtdb-simulator-vs-prod-agreement` probe does — it DEPLOYS a real ruleset to
 * the dedicated oracle database, EXECUTES each corpus op against the live
 * service (recording allow/deny), then RESTORES the prior ruleset and VERIFIES
 * the restore by reading the rules back and byte-comparing to the pre-run
 * snapshot. One observation per scenario lands as `rules-rtdb-<scenario.id>.json`.
 *
 * CAPTURED: the `rules-rtdb-*` chain has run against the live oracle database,
 * so `rules-rtdb-` is an `observationPrefixes` entry and its observations back
 * the `rtdb-rules` native surface (surfaces/rtdb-rules.ts). Without
 * PYRIC_ORACLE_FIREBASE_CONFIG the runner makes no network calls at all: it
 * prints the capture plan and exits 0.
 */
export const rig: RigManifestRecord = {
  description:
    'Deploys the RTDB rules conformance corpus to the dedicated oracle database, executes each op against the live service (RTDB has no server-side rules test API), records the production allow/deny verdict, then restores the prior ruleset and verifies the restore by read-back byte-compare; captures a per-case ALLOW/DENY verdict table as rules-rtdb- observations.',
  script: 'packages/conformance/src/run-rules-rtdb.ts',
  observationPrefixes: ['rules-rtdb-'],
  pendingPrefixes: [],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Web SDK config JSON for the dedicated oracle Firebase project, including databaseURL and apiKey. Provides the client used to run corpus ops (anonymous sign-in) against the live database and the RTDB instance URL. Its presence also gates capture: absent, the runner prints the inert plan and makes no network calls.',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Path to a service-account JSON, defaulting to ignored/service-account.json. Required to mint the short-lived firebase.database-scoped OAuth token the rules-deploy endpoint (/.settings/rules.json) demands and to seed data via the admin SDK — a web config alone cannot deploy RTDB rules, so a resolvable service account is mandatory for a real capture even though the env var itself may be omitted in favor of the default path.',
        permission: 'roles/firebasedatabase.admin (firebase.database OAuth scope)',
      },
    ],
    projectFeatures: [
      'Anonymous sign-in enabled (Authentication → Sign-in method → Anonymous) — the corpus ops run as an anonymous user and signed-out.',
      'RTDB instance provisioned on the dedicated oracle project; the service account holds a role granting the firebase.database scope so /.settings/rules.json PUT/GET succeed.',
    ],
    local: [],
  },
  safety: {
    writes:
      'Deploys test rulesets to the dedicated oracle database under a unique run-scoped audit namespace MERGED with (never replacing) the existing rules, and writes/reads synthetic op data beneath that namespace as an anonymous user. Mutates the live rules document for the duration of a capture only.',
    cleanup:
      'TWO invariants gate a clean run, and BOTH are read-back verified. (1) RULES RESTORED: the runner rewrites the exact pre-run rules snapshot and verifies it by reading the rules back and canonical-JSON comparing to the snapshot. (2) DATA REMOVED: the corpus ops write synthetic data beneath the run-scoped namespace `pyric_oracle_rulesrtdb_<runId>`, so the runner deletes that namespace with the admin token and verifies the deletion by a shallow read of the database root, which must no longer list the key. Both run in the same `finally` path, so any failure mid-run (deploy, op, or read-back) still triggers restore AND data cleanup before exit; either invariant failing to verify aborts loudly and refuses to write observations. The only residual exposure is a hard process kill (SIGKILL) mid-run, which would leave the run-scoped rules subtree deployed alongside — but not overwriting — the real rules, plus its data namespace; a subsequent run restores from its own fresh snapshot, and the stale namespace is inert data under a unique key.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase/package.json version, for the same consistency reason as the Firestore and Storage rules rigs.',
  },
};
