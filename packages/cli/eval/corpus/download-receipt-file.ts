import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'download-receipt-file',
  prompt: 'Pull down the bytes of uploads/bob/invoice.txt so I can see whether the import wrote garbage into it.',
  seed: {
    storage: [
      { path: 'uploads/bob/invoice.txt', contentBase64: 'aW52b2ljZQ==', contentType: 'text/plain' },
    ],
  },
  acceptedFirstOperations: ['download_storage_file'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'download_storage_file' && c.ok)) {
      return 'uploads/bob/invoice.txt was never downloaded';
    }
    return true;
  },
  tags: ['storage', 'read'],
};

export default task;
