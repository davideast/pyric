import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'read-upload-metadata',
  prompt: 'What content type and size did we store for uploads/alice/receipt.pdf? The Zendesk macro is rendering it as text.',
  seed: {
    storage: [
      {
        path: 'uploads/alice/receipt.pdf',
        contentBase64: 'JVBERi0xLjQK',
        contentType: 'application/pdf',
      },
    ],
  },
  acceptedFirstOperations: ['get_storage_metadata'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'get_storage_metadata' && c.ok)) {
      return 'the metadata for uploads/alice/receipt.pdf was never read';
    }
    return true;
  },
  tags: ['storage', 'read'],
};

export default task;
