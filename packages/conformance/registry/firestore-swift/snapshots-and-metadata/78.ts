import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 150,
  api: 'DocumentChange (type, document, oldIndex, newIndex)',
  behavior: 'Delta change descriptor indicating added, modified, or removed mutations.',
  featureKeys: ['documentChange'],
  status: 'conforms',
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
