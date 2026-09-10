import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'inspect-sandbox-state',
  prompt: 'Give me a quick read on what is sitting in the sandbox right now before I start poking at it.',
  seed: {
    users: [{ uid: 'alice', email: 'alice@acme.test', tenantId: 'tenant-acme' }],
    firestore: { 'orgs/acme': { name: 'Acme Corp', plan: 'team' } },
  },
  acceptedFirstOperations: ['inspect_sandbox'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'inspect_sandbox' && c.ok)) {
      return 'the sandbox state was never inspected';
    }
    return true;
  },
  tags: ['sandbox', 'read'],
};

export default task;
