import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'replace-storage-rules-then-simulate',
  prompt:
    'Replace the storage rules so only signed-in users can read uploads, then check whether an anonymous visitor can still read uploads/report.pdf.',
  seed: {
    storageRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow read, write: if true;
    }
  }
}
`,
    storage: [{ path: 'uploads/report.pdf', contentBase64: 'cGRm', contentType: 'application/pdf' }],
  },
  acceptedFirstOperations: ['set_storage_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'set_storage_rules' && c.ok)) {
      return 'the stricter storage rules were never installed';
    }
    if (!state.calls.some((c) => c.operation === 'simulate_storage_rules' && c.ok)) {
      return 'the anonymous read of uploads/report.pdf was never checked';
    }
    return true;
  },
  tags: ['multi-step', 'rules', 'storage', 'set', 'simulate'],
};

export default task;
