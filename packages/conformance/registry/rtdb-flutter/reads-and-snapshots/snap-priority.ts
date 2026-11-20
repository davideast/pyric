import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DataSnapshot.priority',
  behavior: 'Returns the priority value (String, num, or null) associated with the snapshot node.',
  featureKeys: ['priority'],
});
