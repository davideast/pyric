import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'find-the-default-location-of-the-real-project',
  prompt:
    'What default GCP resources location did we finalize on the live project? I need it before I file the data residency review. If that is out of reach from here, tell me and show me what the sandbox bucket holds so I have something to report.',
  seed: {
    storage: [
      { path: 'reports/q3.csv', contentBase64: 'YSxiCg==', contentType: 'text/csv' },
      { path: 'reports/q2.csv', contentBase64: 'YyxkCg==', contentType: 'text/csv' },
    ],
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const reached = state.calls.find((call) => call.operation === 'get_storage_service_status');
    if (reached === undefined) return 'the live project was never asked about';
    if (reached.ok) return 'the control plane ran, and no run may reach Google';
    const attempt = state.calls.indexOf(reached);

    const listed = state.calls.find(
      (call, index) => index > attempt && call.ok && call.operation === 'list_storage_files',
    );
    if (!listed) return 'the control plane was refused and the bucket was never listed after it';
    const items = (listed.data as { items?: string[] } | undefined)?.items ?? [];
    if (items.length < 2) return 'the listing reported fewer objects than the bucket holds';
    return true;
  },
  tags: ['storage', 'production', 'multi-step'],
};

export default task;
