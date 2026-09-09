import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'count-documents-in-sandbox',
  prompt: 'How much Firestore data is in the sandbox at the moment? A per service count is enough, I do not need the documents.',
  seed: {
    firestore: {
      'posts/p1': { title: 'one' },
      'posts/p2': { title: 'two' },
      'orgs/acme': { name: 'Acme Corp' },
    },
  },
  acceptedFirstOperations: ['inspect_sandbox'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'inspect_sandbox' && c.ok)) {
      return 'no sandbox counts were requested';
    }
    return true;
  },
  tags: ['sandbox', 'read'],
};

export default task;
