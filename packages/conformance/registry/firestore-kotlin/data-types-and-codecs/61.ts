import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Blob codec',
  behavior: 'Serializes byte arrays to base64 bridge wire format and revives them as Blob.',
  featureKeys: ['Blob'],
  flipped: 'unit-backed',
});
