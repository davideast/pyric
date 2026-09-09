import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'batch-seed-three-products',
  prompt: 'Seed three products in one shot: products/p1 named Starter at 0, products/p2 named Team at 29, products/p3 named Scale at 99.',
  seed: {},
  acceptedFirstOperations: ['batch_firestore_writes'],
  assert: (state) => {
    for (const [id, price] of [['p1', 0], ['p2', 29], ['p3', 99]] as Array<[string, number]>) {
      const doc = state.firestore.get('products/' + id);
      if (!doc) return 'products/' + id + ' does not exist';
      if (doc.price !== price) return 'products/' + id + ' has the wrong price';
    }
    return true;
  },
  tags: ['firestore', 'write', 'batch'],
};

export default task;
