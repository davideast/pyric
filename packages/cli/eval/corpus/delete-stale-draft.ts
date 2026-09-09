import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'delete-stale-draft',
  prompt: 'posts/draft_88 is a leftover from a demo. Delete it, keep posts/draft_89.',
  seed: {
    firestore: {
      'posts/draft_88': { title: 'demo leftover', published: false },
      'posts/draft_89': { title: 'real draft', published: false },
    },
  },
  acceptedFirstOperations: ['delete_firestore_document'],
  assert: (state) => {
    if (state.firestore.get('posts/draft_88')) return 'posts/draft_88 still exists';
    if (!state.firestore.get('posts/draft_89')) return 'posts/draft_89 was deleted as well';
    return true;
  },
  tags: ['firestore', 'write'],
};

export default task;
