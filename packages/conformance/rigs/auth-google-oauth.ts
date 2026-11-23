import type { RigManifestRecord } from './types.ts';

/**
 * Local human-witnessed Google OAuth (`google.com`) collision rig (#1814).
 *
 * Seeds two run-scoped unverified password accounts (one `@gmail.com`, one
 * non-`@gmail.com`) marked with `{ pyricOracleGoogleOAuthTest: true }`, opens a
 * localhost page where the operator performs two interactive `signInWithPopup`
 * clicks with dedicated throwaway Google accounts, records only sanitized
 * structural facts (booleans, provider ids, and `auth/*` error codes -- never
 * emails, UIDs, display names, photo URLs, or tokens), and deletes all created
 * test users in `finally` with read-back verification.
 */
export const rig: RigManifestRecord = {
  description:
    'Serves a localhost Firebase Auth page for two human-witnessed Google OAuth (google.com) popup sign-ins against run-scoped unverified password accounts (@gmail.com and non-@gmail.com), recording sanitized collision/overwrite facts as auth-google-oauth- observations.',
  script: 'packages/conformance/src/capture/auth-google-oauth/harness.ts',
  observationPrefixes: [],
  pendingPrefixes: ['auth-google-oauth-'],
  automation: 'human-witnessed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through Application Default Credentials impersonating the oracle service account.',
        permission:
          'firebaseauth.users.create, firebaseauth.users.get, firebaseauth.users.update, firebaseauth.users.delete, firebase.projects.get, firebase.clients.list, firebase.clients.get, and firebaseauth.configs.get.',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account key JSON path when not using Application Default Credentials.',
        permission:
          'firebaseauth.users.create, firebaseauth.users.get, firebaseauth.users.update, firebaseauth.users.delete, firebase.projects.get, firebase.clients.list, firebase.clients.get, and firebaseauth.configs.get.',
      },
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Optional single-line Firebase Web App config JSON for the oracle project; when unset, fetched from the Firebase Management API.',
        permission: 'firebase.projects.get, firebase.clients.list, and firebase.clients.get.',
      },
    ],
    projectFeatures: [
      'Firebase Authentication enabled with Email/Password and Google (google.com) sign-in providers enabled.',
      'localhost listed under Firebase Authentication -> Settings -> Authorized domains.',
    ],
    local: [
      'A headed desktop web browser on the operator machine to complete two interactive Google OAuth sign-in popups.',
      'Two dedicated throwaway Google accounts passed explicitly via --gmail=<address> and --non-gmail=<address> (see docs/auth/google-oauth-capture-runbook.md).',
    ],
  },
  safety: {
    writes:
      'Creates two run-scoped unverified password users carrying custom claim { pyricOracleGoogleOAuthTest: true } in the oracle project and writes observations/auth/auth-google-oauth-unverified-collision.json with zero PII or tokens.',
    cleanup:
      'Startup sweep removes only orphaned users carrying { pyricOracleGoogleOAuthTest: true }; pre-flight aborts if either target email already exists unmarked; finally deletes only users created in this run and verifies each deletion via getUser.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Stamps both fbSdkVersion and adminSdkVersion from the installed workspace packages, checked by packages/conformance/src/check-observation-versions.ts.',
  },
};
