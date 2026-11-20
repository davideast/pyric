import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseQuery.removeObserver(withHandle:)',
  behavior: 'Cancels the active observer or AsyncStream task and unsubscribes the worker listener.',
  featureKeys: ['removeObserver'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
