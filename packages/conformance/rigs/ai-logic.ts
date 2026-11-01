import type { RigManifestRecord } from './types.ts';

/**
 * The Firebase AI Logic oracle (`packages/conformance/src/ai-probes.ts`). Calls the
 * production Firebase AI Logic proxy (firebasevertexai.googleapis.com, the
 * Gemini Developer API backend) with raw fetch that replicates the installed
 * `@firebase/ai` request shape, and freezes the deterministic facts — error
 * envelopes, SSE framing, response envelope key sets, function-call shape, and
 * countTokens behavior — as `ai-` observations. Generated text is never a
 * claim. AI Logic on the oracle project rejects requests without a valid App
 * Check token, so the runner mints one with firebase-admin and sends it on
 * every request. Without PYRIC_AI_FIREBASE_CONFIG or PYRIC_ORACLE_SA_PATH the
 * runner exits before any network call (it prints the missing-variable message
 * and stops).
 */
export const rig: RigManifestRecord = {
  description:
    'Calls the production Firebase AI Logic proxy (firebasevertexai.googleapis.com) with raw fetch replicating the installed @firebase/ai request shape; captures deterministic error, SSE-framing, envelope, function-call, and countTokens facts as ai- observations.',
  script: 'packages/conformance/src/ai-probes.ts',
  observationPrefixes: ['ai-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_AI_FIREBASE_CONFIG',
        description:
          'Single-line JSON web app config for a Firebase project with AI Logic enabled. The rig reads apiKey and projectId from it: projectId builds the firebasevertexai.googleapis.com resource path and apiKey is sent as the x-goog-api-key header on every request.',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Service-account JSON path for the same project as PYRIC_AI_FIREBASE_CONFIG (the runner refuses a mismatch). Backs firebase-admin createToken, which mints the App Check token sent as the X-Firebase-AppCheck header on every request. Optional: unset, the rig uses Application Default Credentials and PYRIC_ORACLE_PROJECT_ID names the project.',
        permission: 'firebaseappcheck.tokens.mint (createToken)',
      },
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'The oracle project id, read when PYRIC_ORACLE_SA_PATH is unset. The rig then authenticates with Application Default Credentials from `gcloud auth application-default login --impersonate-service-account=<oracle service account>`, as packages/conformance/docs/oracle-project-setup.md describes.',
        permission: 'firebaseappcheck.tokens.mint (createToken)',
      },
    ],
    projectFeatures: [
      'Firebase App Check API enabled on the project.',
      'Firebase AI Logic enabled on the project, with the Gemini Developer API (GoogleAI) backend reachable through the firebasevertexai.googleapis.com proxy for the config web app.',
    ],
    local: [],
  },
  safety: {
    writes:
      'No Firebase mutation — the probes only POST generateContent/streamGenerateContent/countTokens requests and read the responses. The run mints short-lived App Check tokens with firebase-admin createToken, which changes nothing remote. The only writes are the local observation JSON files under observations/ai/. Real inference requests consume model quota against the config project.',
    cleanup:
      'Not applicable; the rig performs no remote mutation to clean up. It overwrites its own ai- observation files in place on each run.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase/package.json version. Each observation stamps fbSdkVersion from the installed umbrella firebase package; the @firebase/ai request shape these probes replicate is that umbrella version pinned ai subpackage.',
  },
};
