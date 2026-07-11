import type { RigManifestRecord } from './types.ts';

/**
 * The Firebase AI Logic oracle (`scripts/oracle/ai-probes.ts`). Calls the
 * production Firebase AI Logic proxy (firebasevertexai.googleapis.com, the
 * Gemini Developer API backend) with raw fetch that replicates the installed
 * `@firebase/ai` request shape, and freezes the deterministic facts — error
 * envelopes, SSE framing, response envelope key sets, function-call shape, and
 * countTokens behavior — as `ai-` observations. Generated text is never a
 * claim. Without PYRIC_AI_FIREBASE_CONFIG the runner exits before any network
 * call (it prints the missing-variable message and stops).
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
    ],
    projectFeatures: [
      'Firebase AI Logic enabled on the project, with the Gemini Developer API (GoogleAI) backend reachable through the firebasevertexai.googleapis.com proxy for the config web app.',
    ],
    local: [],
  },
  safety: {
    writes:
      'No Firebase mutation — the probes only POST generateContent/streamGenerateContent/countTokens requests and read the responses. The only writes are the local observation JSON files under scripts/oracle/observations/. Real inference requests consume model quota against the config project.',
    cleanup:
      'Not applicable; the rig performs no remote mutation to clean up. It overwrites its own ai- observation files in place on each run.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by scripts/oracle/check-observation-versions.ts against the installed node_modules/firebase/package.json version. Each observation stamps fbSdkVersion from the installed umbrella firebase package; the @firebase/ai request shape these probes replicate is that umbrella version pinned ai subpackage.',
  },
};
