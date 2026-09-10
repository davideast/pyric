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
  id: 'prove-the-upload-rule-needs-the-firestore-role',
  prompt:
    'Before I file the IAM request I want evidence. Show me a read of uploads/report.csv passing as things stand, then show me the same read once Storage can no longer reach Firestore.',
  seed: {
    storageRules: CROSS_SERVICE_STORAGE_RULES,
    firestore: { 'flags/uploads': { on: true } },
    storage: [{ path: 'uploads/report.csv', contentBase64: 'YSxiCg==', contentType: 'text/csv' }],
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const verdicts = state.calls.filter(
      (call) => call.operation === 'simulate_storage_rules' && call.ok,
    );
    if (verdicts.length < 2) return 'the rule was decided fewer than two ways';
    const first = (verdicts[0]?.data as { allowed?: boolean } | undefined)?.allowed;
    const last = (verdicts[verdicts.length - 1]?.data as { allowed?: boolean } | undefined)
      ?.allowed;
    if (first !== true) return 'the rule did not pass as things stand';
    if (last !== false) return 'the rule still passed once Storage could not reach Firestore';
    if (!state.calls.some((call) => call.operation === 'set_storage_cross_service_iam' && call.ok)) {
      return 'the posture was never changed, so the second verdict came from something else';
    }
    return true;
  },
  tags: ['storage', 'rules', 'multi-step'],
};

export default task;
