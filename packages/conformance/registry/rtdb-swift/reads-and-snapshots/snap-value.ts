import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DataSnapshot.value',
  behavior: 'Returns the deserialized Swift value (Dictionary, Array, String, NSNumber, or nil) of the snapshot.',
  featureKeys: ['snapshotValue'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
