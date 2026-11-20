import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.childEvents / onChildChanged',
  behavior: 'Emits ChildEvent.Changed whenever an existing child node is modified.',
  featureKeys: ['onChildChanged'],
});
