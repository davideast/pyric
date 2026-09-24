import type { RigManifestRecord } from './types.ts';

/**
 * The client Storage rig (`packages/conformance/src/client-storage-probes.ts`).
 * Pure in-process probes of the INSTALLED `firebase/storage` package:
 * `ref(storage, url)` parses gs://, Firebase download, and Cloud Storage URLs in
 * the client, so what it accepts, what reference it builds, and what it throws
 * are facts of the installed SDK. No credentials, no project, no network.
 * Captures `client-storage-` observations.
 */
export const rig: RigManifestRecord = {
  description:
    'Pure in-process probes of the installed firebase/storage package: ref(storage, url) parsing of gs://, firebasestorage.googleapis.com download, storage.googleapis.com, other-host, and data: inputs, and ref(reference, url); no credentials or network. Captures client-storage- observations.',
  script: 'packages/conformance/src/client-storage-probes.ts',
  observationPrefixes: ['client-storage-'],
  automation: 'unattended',
  network: 'none',
  requires: {
    env: [],
    projectFeatures: [],
    local: [
      'Installed firebase package in node_modules (already a workspace dependency). initializeApp is fed placeholder FirebaseOptions and getStorage builds a service handle; ref() issues no request.',
    ],
  },
  safety: {
    writes: 'None. ref() builds references in memory; no Storage operation runs, so nothing reaches a project.',
    cleanup: 'The probe initializes a uniquely named app and deletes it in a finally block.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase/package.json version; running the script without --write replays the probe and compares.',
  },
};
