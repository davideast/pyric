import { row } from './section.ts';

export default row({
  order: 10,
  api: 'MultiFactorPlatform interface contract',
  behavior: 'Exposes stub MultiFactorPlatform for enrolled multi-factor inspection.',
  featureKeys: ['multiFactor'],
  flipped: 'unit-backed',
});
