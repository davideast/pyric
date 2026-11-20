import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentSnapshot.get(_:)',
  behavior: 'Extracts nested field value supporting dot-delimited string or FieldPath.',
  featureKeys: ['get'],
  status: 'conforms',
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
