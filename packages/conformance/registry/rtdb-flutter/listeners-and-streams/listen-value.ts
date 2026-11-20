import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.onValue',
  behavior: 'Emits DatabaseEvent with full DataSnapshot initially and upon any data change at the path.',
  featureKeys: ['onValue'],
});
