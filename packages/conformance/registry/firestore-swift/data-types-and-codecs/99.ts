import { row } from './section.ts';

export default row({
  order: 20,
  api: 'GeoPoint',
  behavior: 'Immutable geographic coordinate pair with latitude and longitude bounds.',
  featureKeys: ['geoPoint'],
  flipped: 'unit-backed',
});
