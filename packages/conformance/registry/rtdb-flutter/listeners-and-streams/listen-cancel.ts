import { row } from './section.ts';

export default row({
  order: 50,
  api: 'StreamSubscription.cancel()',
  behavior: 'Cancels the active stream subscription and unsubscribes the worker listener.',
  featureKeys: ['listenCancel'],
});
