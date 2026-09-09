import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'lint-storage-rules',
  prompt: 'Run a check over my storage rules before I ship them. Uploads under uploads/ feel too open to me.',
  seed: {
    storageRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{userId}/{file} {
      allow read: if true;
      allow write: if request.auth != null
    }
  }
}
`,
  },
  acceptedFirstOperations: ['lint_storage_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'lint_storage_rules' && c.ok)) {
      return 'the storage rules were never linted';
    }
    return true;
  },
  tags: ['rules', 'storage', 'lint'],
};

export default task;
