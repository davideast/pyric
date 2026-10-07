import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description:
    'Read-only Storage stdlib discovery: paired source/module boundaries, pure function-family intersection, and advanced Storage metadata/object shapes through projects.test.',
  script: 'packages/conformance/src/run-storage-stdlib-discovery.ts',
  observationPrefixes: ['stdlib-storage-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [{
      name: 'GOOGLE_APPLICATION_CREDENTIALS',
      description: 'Application Default Credentials file for the Rules Test API project. Without it the runner uses a firebase-tools login or the gcloud ADC file.',
      permission: 'firebaserules.rulesets.test',
    }],
    projectFeatures: [],
    local: [],
  },
  safety: {
    writes: 'Writes only local observation JSON; projects.test does not deploy rules or mutate Firebase data.',
    cleanup: 'Not applicable; Firebase receives synthetic evaluations only.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy: 'Observation versions are checked against the installed Firebase SDK by the conformance freshness guard.',
  },
};
