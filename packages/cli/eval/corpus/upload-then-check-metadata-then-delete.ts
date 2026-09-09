import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'upload-then-check-metadata-then-delete',
  prompt: 'Upload a throwaway text file at tmp/probe.txt, tell me what content type it landed with, then delete it again.',
  seed: {
    storageRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}
`,
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'upload_storage_file' && c.ok)) {
      return 'tmp/probe.txt was never uploaded';
    }
    if (!state.calls.some((c) => c.operation === 'get_storage_metadata' && c.ok)) {
      return 'the content type of tmp/probe.txt was never read';
    }
    if (state.storage.get('tmp/probe.txt')) return 'tmp/probe.txt is still in storage';
    return true;
  },
  tags: ['multi-step', 'storage', 'write', 'read'],
};

export default task;
