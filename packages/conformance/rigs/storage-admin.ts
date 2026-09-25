import type { RigManifestRecord } from './types.ts';

/**
 * The firebase-admin Storage rig (`packages/conformance/src/storage-admin-probes.ts`).
 * Writes one object through the Admin SDK, sets and removes custom metadata and
 * its download token, and fetches its download URL without credentials, freezing
 * what production does as `admin-storage-` observations. The Admin SDK bypasses
 * security rules, so the rig deploys none.
 */
export const rig: RigManifestRecord = {
  description:
    'Credentialed firebase-admin Storage probes: File.setMetadata/getMetadata custom metadata and getDownloadURL token minting, serving, ranges, and revocation against the oracle project bucket.',
  script: 'packages/conformance/src/storage-admin-probes.ts',
  observationPrefixes: ['admin-storage-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description: 'Path to the oracle project service-account JSON; the Admin SDK authenticates with it.',
        permission: 'storage.objects.create, storage.objects.get, storage.objects.update, storage.objects.delete on the bucket',
      },
      {
        name: 'PYRIC_ORACLE_STORAGE_BUCKET',
        description: "The oracle project's Firebase Storage bucket, such as <project>.firebasestorage.app.",
      },
    ],
    projectFeatures: ['Firebase Storage enabled with a default bucket in the oracle project.'],
    local: ['Installed firebase-admin package.'],
  },
  safety: {
    writes:
      'One 64-byte object under pyric_oracle/admin_storage_<timestamp>/, written and updated through the Admin SDK. No security rules are deployed.',
    cleanup:
      'The object is deleted in a finally block and the temporary Admin app is deleted.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'adminSdkVersion',
    policy:
      'Checked against the installed firebase-admin package; live behavior drift is detected by running the script without --write, which replays the probe and compares.',
  },
};
