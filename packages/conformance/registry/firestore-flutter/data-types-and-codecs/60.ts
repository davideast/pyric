import { row } from './section.ts';

export default row({
  order: 20,
  api: 'GeoPoint codec',
  behavior: 'Serializes and revives GeoPoint coordinates (latitude, longitude) over WebSocket bridge.',
  featureKeys: ['GeoPoint'],
  flipped: 'unit-backed',
});
