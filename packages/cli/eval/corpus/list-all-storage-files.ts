import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-all-storage-files',
  prompt: 'What is in the storage bucket at all right now? I want the full list, no prefix filter.',
  seed: {
    storage: [
      { path: 'branding/logo.png', contentBase64: 'aGVsbG8=', contentType: 'image/png' },
      { path: 'uploads/alice/photo.png', contentBase64: 'aGVsbG8=', contentType: 'image/png' },
      { path: 'tmp/scratch.bin', contentBase64: 'aGVsbG8=' },
    ],
  },
  acceptedFirstOperations: ['list_storage_files'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'list_storage_files' && c.ok)) {
      return 'the storage bucket was never listed';
    }
    return true;
  },
  tags: ['storage', 'read'],
};

export default task;
