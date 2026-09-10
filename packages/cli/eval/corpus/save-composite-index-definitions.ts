import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'save-composite-index-definitions',
  prompt:
    'A query on tasks filters tenant equal to tenant-acme and priority greater than 2, ordered by priority. Confirm the composite index it needs and save that definition to disk.',
  seed: {
    firestore: {
      'tasks/t1': { tenant: 'tenant-acme', priority: 3 },
    },
  },
  acceptedFirstOperations: ['extract_firestore_indexes'],
  assert: (state) => {
    const written = state.calls.find((c) => c.operation === 'write_firestore_indexes' && c.ok);
    if (!written) return 'the index definition was never written to disk';
    return true;
  },
  tags: ['firestore', 'write'],
};

export default task;
