import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'turn-on-storage-for-the-real-project',
  prompt:
    'Storage was never switched on for the live project. Turn it on and create the default bucket. If that cannot happen from here, say why, then upload assets/placeholder.txt with the bytes cGxhY2Vob2xkZXI= into the sandbox so the client work is not blocked.',
  seed: {},
  acceptedFirstOperations: [],
  assert: (state) => {
    const reached = state.calls.find((call) => call.operation === 'provision_storage_bucket');
    if (reached === undefined) return 'provisioning the live project was never attempted';
    if (reached.ok) return 'the control plane ran, and no run may reach Google';
    const attempt = state.calls.indexOf(reached);

    const uploaded = state.calls.find(
      (call, index) => index > attempt && call.ok && call.operation === 'upload_storage_file',
    );
    if (!uploaded) return 'the control plane was refused and nothing local was done after it';
    const placeholder = state.storage.get('assets/placeholder.txt');
    if (!placeholder) return 'assets/placeholder.txt was not uploaded';
    return true;
  },
  tags: ['storage', 'production', 'multi-step'],
};

export default task;
