import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.onChildChanged',
  behavior: 'Emits DatabaseEvent whenever an existing child node is modified.',
  featureKeys: ['onChildChanged'],
});
