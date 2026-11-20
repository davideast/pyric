import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Query.onChildRemoved',
  behavior: 'Emits DatabaseEvent whenever a child node is removed from the watched location.',
  featureKeys: ['onChildRemoved'],
});
