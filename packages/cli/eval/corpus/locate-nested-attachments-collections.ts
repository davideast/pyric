import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'locate-nested-attachments-collections',
  prompt: 'Where in the tree do attachments collections live? I misplaced my notes on the schema.',
  seed: {
    firestore: {
      'tickets/t1/attachments/a1': { name: 'log.txt' },
    },
  },
  acceptedFirstOperations: ['find_firestore_collection_group'],
  assert: (state) => {
    const found = state.calls.find(
      (c) => c.operation === 'find_firestore_collection_group' && c.ok,
    );
    if (!found) return 'attachments was never searched for as a collection group';
    const hosts = (found.data as { hosts?: Array<{ path: string }> } | undefined)?.hosts;
    if (hosts !== undefined && !hosts.some((host) => host.path === 'tickets/t1/attachments')) {
      return 'the tickets/t1/attachments host was not found';
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
