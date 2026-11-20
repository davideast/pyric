import type { RigManifestRecord } from './types.ts';

/**
 * Upstream Android Firebase SDK Robolectric oracle runner
 * (`packages/conformance/src/android-sdk-probes.ts`). Executes probe descriptors
 * under `packages/conformance/probes/{auth-kotlin,rtdb-kotlin}/<name>.ts`
 * declaring `rig: 'android-sdk-probes'` against real
 * `com.google.firebase:firebase-auth` and `com.google.firebase:firebase-database`
 * inside a Robolectric Android 35 JVM sandbox on `ubuntu-latest`.
 */
export const rig: RigManifestRecord = {
  description:
    'Upstream Android Firebase SDK Robolectric oracle runner over packages/conformance/probes/{auth-kotlin,rtdb-kotlin}/<name>.ts with isolated pyric_oracle/<runId> namespaces and dedicated RTDB pinning.',
  script: 'packages/conformance/src/android-sdk-probes.ts',
  observationPrefixes: [],
  probeDeclaredOwnership: true,
  automation: 'credentialed',
  network: 'firebase-production',
  runnerOs: 'ubuntu-latest',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through main-only Workload Identity Federation or Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/firebaseauth.admin, roles/firebasedatabase.admin',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account key JSON path when not using Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/firebaseauth.admin, roles/firebasedatabase.admin',
      },
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Optional Firebase client config JSON override for the dedicated oracle project; when unset, discovered automatically via the Firebase Management REST API.',
      },
      {
        name: 'PYRIC_ORACLE_RTDB_URL',
        description:
          'Dedicated non-default RTDB instance URL (e.g. https://pyric-oracle-rtdb-2.firebaseio.com), required by rtdb-kotlin probes.',
        permission: 'roles/firebasedatabase.admin',
      },
    ],
    projectFeatures: [
      'Anonymous sign-in enabled on the dedicated oracle project.',
      'Dedicated non-default Realtime Database instance provisioned.',
    ],
    local: [
      'Android SDK Platform 35 (ANDROID_HOME / ANDROID_SDK_ROOT) and JDK 21+ toolchain.',
    ],
  },
  safety: {
    writes:
      'Ephemeral Firebase Auth test accounts and run-scoped RTDB nodes strictly under pyric_oracle/<runId> on the dedicated non-default RTDB instance.',
    cleanup:
      'Deletes created Auth accounts via firebase-admin/auth, removes pyric_oracle/<runId> RTDB subtrees, disconnects FirebaseDatabase, and deletes temporary Gradle/config directories in finally.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'androidBomVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against firebaseBomVersion in packages/conformance/rigs/native-android-oracle/gradle.properties.',
  },
};
