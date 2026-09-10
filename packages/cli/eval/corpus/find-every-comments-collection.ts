import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'find-every-comments-collection',
  prompt:
    'Find every place in this database that has a comments subcollection, wherever it is nested. I want a collectionGroup query to work everywhere it should.',
  seed: {
    firestore: {
      'posts/p1/comments/c1': { text: 'nice' },
      'orgs/org-a/threads/t1/comments/c2': { text: 'agreed' },
    },
  },
  acceptedFirstOperations: ['find_firestore_collection_group'],
  assert: (state) => {
    const found = state.calls.find(
      (c) => c.operation === 'find_firestore_collection_group' && c.ok,
    );
    if (!found) return 'comments was never searched for as a collection group';
    const hosts = (found.data as { hosts?: Array<{ path: string }> } | undefined)?.hosts;
    if (hosts !== undefined && hosts.length < 2) {
      return `only ${hosts.length} host(s) were found, but comments is nested in two places`;
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
