import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.cancelDisconnectOperations()',
  behavior: 'Cancels previously queued OnDisconnect operations at the reference path.',
  featureKeys: ['onDisconnectCancel'],
});
