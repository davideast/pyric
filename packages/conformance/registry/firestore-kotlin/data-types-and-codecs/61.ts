import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Blob codec',
  behavior: 'Serializes byte arrays to base64 bridge wire format and revives them as Blob.',
  featureKeys: ['Blob'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
