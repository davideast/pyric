import { row } from './section.ts';

export default row({
  order: 40,
  api: 'AuthLens deep equality semantics',
  behavior: 'Compares token claims and tenant attributes by deep collection equality to avoid spurious re-subscriptions.',
  featureKeys: ['AuthLens'],
  flipped: 'unit-backed',
});
