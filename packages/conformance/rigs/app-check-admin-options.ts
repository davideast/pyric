import type { RigManifestRecord } from './types.ts';

/**
 * firebase-admin App Check createToken option edges
 * (`packages/conformance/src/app-check-admin-option-probes.ts`). Owns the
 * `app-check-admin-options-` observations by longest-prefix match over the
 * app-check rig's `app-check-` prefix. Without both env vars the runner
 * prints what it would capture and exits 0 before any network call.
 */
export const rig: RigManifestRecord = {
  description:
    'Captures firebase-admin createToken option edges on the production oracle project: which malformed options throw synchronously and which reject (with messages), the ttl of limitedUse tokens, whether a chosen jti is carried, fractional ttlMillis rounding, and verifyToken consume on two same-jti tokens, as app-check-admin-options- observations with every token reduced to its shape.',
  script: 'packages/conformance/src/app-check-admin-option-probes.ts',
  observationPrefixes: ['app-check-admin-options-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description: 'Service-account JSON path for the dedicated oracle project. Backs firebase-admin createToken and verifyToken. Optional: unset, the rig uses Application Default Credentials and PYRIC_ORACLE_PROJECT_ID names the project.',
        permission: 'firebaseappcheck.tokens.mint (createToken); firebaseappcheck.appCheckTokens.verify (verifyToken with consume)',
      },
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'The oracle project id, read when PYRIC_ORACLE_SA_PATH is unset. The rig then authenticates with Application Default Credentials from `gcloud auth application-default login --impersonate-service-account=<oracle service account>`, as packages/conformance/docs/oracle-project-setup.md describes.',
        permission: 'firebaseappcheck.tokens.mint (createToken); firebaseappcheck.appCheckTokens.verify (verifyToken with consume)',
      },
      {
        name: 'PYRIC_AI_FIREBASE_CONFIG',
        description:
          'Single-line JSON web app config for the same project (projectId must match the service account). Supplies the appId tokens are minted for.',
      },
    ],
    projectFeatures: ['Firebase App Check API enabled on the project.'],
    local: [],
  },
  safety: {
    writes:
      'Mints five App Check tokens (three limitedUse) and consumes two same-jti limitedUse tokens through verifyToken. Registers no debug token and sends no AI Logic request. Writes the app-check-admin-options- observation files under observations/app-check-admin/.',
    cleanup: 'Not applicable; minted tokens expire on their own and the run registers nothing. It overwrites its own observation files in place on each run.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'adminSdkVersion',
    policy:
      'Every observation stamps adminSdkVersion from the installed firebase-admin package and fbSdkVersion from the installed firebase package; both are checked by packages/conformance/src/check-observation-versions.ts.',
  },
};
