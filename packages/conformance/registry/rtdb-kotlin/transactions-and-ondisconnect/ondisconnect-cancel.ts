import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'OnDisconnect.cancel()',
  behavior: 'Cancels previously queued OnDisconnect operations at the reference path.',
  featureKeys: ['onDisconnectCancel'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
