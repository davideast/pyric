import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'delete-orphan-upload',
  prompt: 'tmp/scratch.bin in storage is an orphan from a failed import. Delete it and leave tmp/keep.bin alone.',
  seed: {
    storage: [
      { path: 'tmp/scratch.bin', contentBase64: 'aGVsbG8=' },
      { path: 'tmp/keep.bin', contentBase64: 'aGVsbG8=' },
    ],
  },
  acceptedFirstOperations: ['delete_storage_file'],
  assert: (state) => {
    if (state.storage.get('tmp/scratch.bin')) return 'tmp/scratch.bin is still in storage';
    if (!state.storage.get('tmp/keep.bin')) return 'tmp/keep.bin was deleted as well';
    return true;
  },
  tags: ['storage', 'write'],
};

export default task;
