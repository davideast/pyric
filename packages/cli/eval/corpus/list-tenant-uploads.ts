import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-tenant-uploads',
  prompt: 'Show me every file we have under uploads/tenant-acme/ in storage.',
  seed: {
    storage: [
      { path: 'uploads/tenant-acme/a.png', contentBase64: 'aGVsbG8=', contentType: 'image/png' },
      { path: 'uploads/tenant-acme/b.png', contentBase64: 'aGVsbG8=', contentType: 'image/png' },
      { path: 'uploads/tenant-globex/c.png', contentBase64: 'aGVsbG8=', contentType: 'image/png' },
    ],
  },
  acceptedFirstOperations: ['list_storage_files'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'list_storage_files' && c.ok)) {
      return 'the uploads prefix was never listed';
    }
    return true;
  },
  tags: ['storage', 'tenant', 'read'],
};

export default task;
