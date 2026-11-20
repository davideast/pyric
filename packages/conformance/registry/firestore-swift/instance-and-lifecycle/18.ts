import { row } from './section.ts';

export default row({
  order: 180,
  api: 'Firestore.waitForPendingWrites()',
  behavior: 'Awaits backend acknowledgment of all pending local writes.',
  featureKeys: ['waitForPendingWrites'],
});
