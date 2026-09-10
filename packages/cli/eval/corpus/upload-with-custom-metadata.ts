import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'upload-with-custom-metadata',
  prompt: 'Upload an export to exports/2026-09/report.csv and tag it with custom metadata owner set to dana_acme.',
  seed: {},
  acceptedFirstOperations: ['upload_storage_file'],
  assert: (state) => {
    const file = state.storage.get('exports/2026-09/report.csv');
    if (!file) return 'exports/2026-09/report.csv was not uploaded';
    if (file.metadata.owner !== 'dana_acme') return 'the owner metadata is not dana_acme';
    return true;
  },
  tags: ['storage', 'write'],
};

export default task;
