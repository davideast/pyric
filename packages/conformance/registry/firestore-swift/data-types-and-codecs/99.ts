import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'GeoPoint',
  behavior: 'Immutable geographic coordinate pair with latitude and longitude bounds.',
  featureKeys: ['geoPoint'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
