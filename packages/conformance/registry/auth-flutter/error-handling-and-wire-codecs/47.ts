import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Bridge auth operation codecs',
  behavior: 'Encodes and decodes auth.* RPC operations and subscription frames across WebSocket bridge.',
  featureKeys: ['bridgeOps'],
  flipped: 'unit-backed',
});
