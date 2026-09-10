import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'write-the-index-file-for-that-query',
  prompt:
    "Orders are filtered by status equal to paid and ordered by createdAt descending. Check whether that needs a composite index, and if it does, go ahead and write it to firestore.indexes.json.",
  seed: {
    firestore: {
      'orders/o1': { status: 'paid', createdAt: 1 },
    },
  },
  acceptedFirstOperations: ['extract_firestore_indexes'],
  assert: (state) => {
    const written = state.calls.find((c) => c.operation === 'write_firestore_indexes' && c.ok);
    if (!written) return 'the index definition was never written';
    const count = (written.data as { count?: number } | undefined)?.count;
    if (count !== undefined && count < 1) return 'the write reported zero indexes';
    return true;
  },
  tags: ['firestore', 'write'],
};

export default task;
