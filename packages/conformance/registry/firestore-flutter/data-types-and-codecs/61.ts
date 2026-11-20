import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Blob codec',
  behavior: 'Serializes Uint8List byte buffers to base64 bridge wire format and revives them as Blob.',
  featureKeys: ['Blob'],
  flipped: 'unit-backed',
});
