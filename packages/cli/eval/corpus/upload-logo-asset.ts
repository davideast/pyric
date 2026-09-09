import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'upload-logo-asset',
  prompt: 'Put a placeholder logo in storage at branding/logo.png. The bytes can be anything, I just need the object to exist.',
  seed: {},
  acceptedFirstOperations: ['upload_storage_file'],
  assert: (state) => {
    if (!state.storage.get('branding/logo.png')) return 'branding/logo.png was not uploaded';
    return true;
  },
  tags: ['storage', 'write'],
};

export default task;
