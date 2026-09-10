import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'replace-avatar-file',
  prompt: 'The avatar at uploads/alice/avatar.png was saved with the wrong content type. Overwrite it with a fresh image/png object.',
  seed: {
    storage: [
      {
        path: 'uploads/alice/avatar.png',
        contentBase64: 'aGVsbG8=',
        contentType: 'application/octet-stream',
      },
    ],
  },
  acceptedFirstOperations: ['upload_storage_file'],
  assert: (state) => {
    const file = state.storage.get('uploads/alice/avatar.png');
    if (!file) return 'uploads/alice/avatar.png is gone';
    if (file.contentType !== 'image/png') return 'the content type is still not image/png';
    return true;
  },
  tags: ['storage', 'write'],
};

export default task;
