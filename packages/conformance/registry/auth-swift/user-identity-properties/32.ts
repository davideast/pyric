import { row } from './section.ts';

export default row({
  order: 80,
  flipped: 'unit-backed',
  api: 'User.providerID',
  behavior: 'Returns the provider identifier for the user identity.',
  featureKeys: ['providerId'],
});
