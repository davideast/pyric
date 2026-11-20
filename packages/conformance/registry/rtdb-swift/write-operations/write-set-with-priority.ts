import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.setValue(_:andPriority:)',
  behavior: 'Atomically writes the node value alongside its ordering priority metadata.',
  featureKeys: ['setValueAndPriority'],
});
