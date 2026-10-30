import type { RigManifestRecord } from './types.ts';

/**
 * AI Logic generateContent request edges
 * (`packages/conformance/src/ai-request-edge-probes.ts`). Owns the
 * `ai-request-edge-` observations by longest-prefix match over the ai-logic
 * rig's `ai-` prefix. Sends exactly three requests with a firebase-admin
 * minted App Check token. Without both env vars the runner prints what it
 * would capture and exits 0 before any network call.
 */
export const rig: RigManifestRecord = {
  description:
    'Sends three generateContent requests to the production Firebase AI Logic proxy (firebasevertexai.googleapis.com, Gemini Developer API backend) in the installed @firebase/ai request shape with a firebase-admin minted App Check token: role-less contents, a top-level string systemInstruction, and the model gemini-pro. Captures status and error facts as ai-request-edge- observations; generated text is never a claim.',
  script: 'packages/conformance/src/ai-request-edge-probes.ts',
  observationPrefixes: ['ai-request-edge-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description: 'Service-account JSON path for the dedicated oracle project. Mints the App Check token sent as X-Firebase-AppCheck. Optional: unset, the rig uses Application Default Credentials and PYRIC_ORACLE_PROJECT_ID names the project.',
        permission: 'firebaseappcheck.tokens.mint (createToken)',
      },
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'The oracle project id, read when PYRIC_ORACLE_SA_PATH is unset. The rig then authenticates with Application Default Credentials from `gcloud auth application-default login --impersonate-service-account=<oracle service account>`, as packages/conformance/docs/oracle-project-setup.md describes.',
        permission: 'firebaseappcheck.tokens.mint (createToken)',
      },
      {
        name: 'PYRIC_AI_FIREBASE_CONFIG',
        description:
          'Single-line JSON web app config for the same project (projectId must match the service account). projectId builds the firebasevertexai.googleapis.com resource path, apiKey is sent as x-goog-api-key, and appId is the app the token is minted for.',
      },
    ],
    projectFeatures: [
      'Firebase AI Logic enabled with the Gemini Developer API (GoogleAI) backend, as for the ai-logic rig.',
      'Firebase App Check API enabled on the project.',
    ],
    local: [],
  },
  safety: {
    writes:
      'Mints one App Check token and sends three generateContent requests (one small inference, two refused requests). No Firebase mutation. Writes the ai-request-edge- observation files under observations/ai/.',
    cleanup: 'Not applicable; the minted token expires on its own and the run performs no remote mutation. It overwrites its own observation files in place on each run.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Each observation stamps fbSdkVersion from the installed firebase package, checked by packages/conformance/src/check-observation-versions.ts; the @firebase/ai request shape replicated is that umbrella version pinned ai subpackage.',
  },
};
