import type { RigManifestRecord } from './types.ts';

/**
 * The Firebase App Check oracle (`packages/conformance/src/app-check-probes.ts`).
 * Captures firebase-admin createToken/verifyToken, the raw exchangeDebugToken
 * REST envelope, and the real web SDK in headless Chromium in debug mode,
 * including the X-Firebase-AppCheck header firebase/ai attaches. Runs with
 * enforcement off; the enforcement captures in
 * packages/conformance/docs/app-check/capture-plan.md are not part of this run.
 */
export const rig: RigManifestRecord = {
  description:
    'Captures production App Check with enforcement off: firebase-admin createToken and verifyToken (including consume), the raw exchangeDebugToken envelope, and firebase/app-check plus firebase/ai in headless Chromium with a run-scoped registered debug token, as app-check- observations with every token reduced to its shape.',
  script: 'packages/conformance/src/app-check-probes.ts',
  observationPrefixes: ['app-check-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Service-account JSON path for the dedicated oracle project. Mints the OAuth token for the App Check management API and backs firebase-admin createToken and verifyToken. Optional: unset, the rig uses Application Default Credentials and PYRIC_ORACLE_PROJECT_ID names the project.',
        permission:
          'firebaseappcheck.debugTokens.get and firebaseappcheck.debugTokens.update (debug token list, create, delete); firebaseappcheck.tokens.mint (createToken); firebaseappcheck.appCheckTokens.verify (verifyToken with consume)',
      },
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'The oracle project id, read when PYRIC_ORACLE_SA_PATH is unset. The rig then authenticates with Application Default Credentials from `gcloud auth application-default login --impersonate-service-account=<oracle service account>`, as packages/conformance/docs/oracle-project-setup.md describes.',
        permission:
          'firebaseappcheck.debugTokens.get and firebaseappcheck.debugTokens.update (debug token list, create, delete); firebaseappcheck.tokens.mint (createToken); firebaseappcheck.appCheckTokens.verify (verifyToken with consume)',
      },
      {
        name: 'PYRIC_AI_FIREBASE_CONFIG',
        description:
          'Web app config JSON for the same project (projectId must match the service account). Supplies appId for token minting and debug tokens, and apiKey for exchangeDebugToken and the firebase/ai requests in the page.',
      },
    ],
    projectFeatures: [
      'Firebase App Check API enabled on the project; the web app need not have a reCAPTCHA registration because the browser captures attest through a debug token.',
      'Firebase AI Logic enabled with the Gemini Developer API backend, as for the ai-logic rig, and App Check enforcement for firebaseml.googleapis.com left UNENFORCED.',
    ],
    local: ['Playwright Chromium is installed.'],
  },
  safety: {
    writes:
      'Registers one debug token named pyric-app-check-capture-<runId> on the config web app. Mints App Check tokens and consumes one through verifyToken. Sends six small generateContent requests from the page (model quota); a run with --only that names only probes without AI requests sends none. Writes the app-check- observation files under observations/app-check/.',
    cleanup:
      'Before registering, deletes any debug token whose display name starts with pyric-app-check-capture- (an interrupted run). A finally block deletes the run token and lists again, failing the run if any run-scoped token remains. Minted tokens expire on their own.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Every observation stamps fbSdkVersion from the installed firebase package; admin-plane observations also stamp adminSdkVersion. Both are checked by packages/conformance/src/check-observation-versions.ts.',
  },
};
