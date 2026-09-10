import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-index-for-tenant-filtered-tasks',
  prompt:
    'A query on tasks filters tenant equal to tenant-acme and priority greater than 2, ordered by priority. Does that combination need a composite index before I deploy?',
  seed: {
    firestore: {
      'tasks/t1': { tenant: 'tenant-acme', priority: 3 },
    },
  },
  acceptedFirstOperations: ['extract_firestore_indexes'],
  assert: (state) => {
    const extracted = state.calls.find((c) => c.operation === 'extract_firestore_indexes' && c.ok);
    if (!extracted) return 'no index requirement was ever checked';
    const indexes = (extracted.data as { indexes?: Array<Record<string, unknown>> } | undefined)
      ?.indexes;
    if (indexes !== undefined && indexes.length < 1) {
      return 'the check reported no composite index, but this query needs one';
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
