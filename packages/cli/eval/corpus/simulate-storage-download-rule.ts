import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'simulate-storage-download-rule',
  prompt: 'Can a signed-out visitor download uploads/alice/photo.png with these storage rules in place? Give me the verdict, not a guess.',
  seed: {
    storageRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{userId}/{file} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
`,
    storage: [
      { path: 'uploads/alice/photo.png', contentBase64: 'aGVsbG8=', contentType: 'image/png' },
    ],
  },
  acceptedFirstOperations: ['simulate_storage_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'simulate_storage_rules' && c.ok)) {
      return 'no storage rules verdict was requested';
    }
    return true;
  },
  tags: ['rules', 'storage', 'simulate'],
};

export default task;
