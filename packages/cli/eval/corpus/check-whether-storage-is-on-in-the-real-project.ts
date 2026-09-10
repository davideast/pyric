import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-whether-storage-is-on-in-the-real-project',
  prompt:
    'Is Firebase Storage actually enabled on our real project, and which buckets are linked? If you cannot reach it, say why and tell me what this sandbox holds instead.',
  seed: {
    storage: [
      { path: 'uploads/receipt.pdf', contentBase64: 'JVBERi0xLjQK', contentType: 'application/pdf' },
    ],
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    // The task names the real project, so a run that never asked for it
    // answered an easier question. The attempt has to be there, and it has to
    // have been refused, before the local answer counts for anything.
    const reached = state.calls.find((call) => call.operation === 'get_storage_service_status');
    if (reached === undefined) return 'the real project was never asked about';
    if (reached.ok) return 'the control plane ran, and no run may reach Google';
    const attempt = state.calls.indexOf(reached);

    const local = state.calls.find(
      (call, index) =>
        index > attempt &&
        call.ok &&
        (call.operation === 'list_storage_files' ||
          call.operation === 'get_storage_metadata' ||
          call.operation === 'inspect_sandbox'),
    );
    if (!local) return 'the control plane was refused and nothing local was tried after it';
    return true;
  },
  tags: ['storage', 'production', 'multi-step'],
};

export default task;
