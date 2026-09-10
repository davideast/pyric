import type { EvalTask } from '../types.js';

const CROSS_SERVICE_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow read, write: if firestore.exists(/databases/(default)/documents/flags/uploads);
    }
  }
}`;

const task: EvalTask = {
  id: 'model-the-project-without-the-firestore-role',
  prompt:
    'Our storage rules read a Firestore flag, and staging has not been granted the role that lets Storage read Firestore. Put the sandbox in that state and tell me whether a read of uploads/report.csv still passes.',
  seed: {
    storageRules: CROSS_SERVICE_STORAGE_RULES,
    firestore: { 'flags/uploads': { on: true } },
    storage: [{ path: 'uploads/report.csv', contentBase64: 'YSxiCg==', contentType: 'text/csv' }],
  },
  acceptedFirstOperations: ['set_storage_cross_service_iam'],
  assert: (state) => {
    // The posture is read off the result rather than the arguments, because
    // each surface variant spells the arguments its own way and the result is
    // the same on all of them.
    const posture = state.calls.findIndex(
      (call) =>
        call.operation === 'set_storage_cross_service_iam' &&
        call.ok &&
        (call.data as { mode?: string } | undefined)?.mode === 'denied',
    );
    if (posture < 0) return 'the sandbox was never put in the denied posture';
    const decided = state.calls.find(
      (call, index) =>
        index > posture && call.operation === 'simulate_storage_rules' && call.ok,
    );
    if (decided === undefined) return 'nothing was simulated after the posture changed';
    const allowed = (decided.data as { allowed?: boolean } | undefined)?.allowed;
    if (allowed !== false) return 'the simulation under the denied posture did not deny';
    return true;
  },
  tags: ['storage', 'rules', 'multi-step'],
};

export default task;
