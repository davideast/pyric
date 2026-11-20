import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.runTransaction(handler)',
  behavior: 'Executes optimistic concurrency transaction handler on MutableData and commits upon success.',
  featureKeys: ['runTransaction'],
});
