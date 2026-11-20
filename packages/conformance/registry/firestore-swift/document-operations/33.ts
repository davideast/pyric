import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 120,
  api: 'DocumentReference.addSnapshotListener(includeMetadataChanges:listener:)',
  behavior: 'Listens to document snapshot updates including metadata-only transitions.',
  featureKeys: ['addSnapshotListenerMetadata'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
