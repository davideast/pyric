import { row } from './section.ts';

export default row({
  order: 30,
  api: 'InternalUserDetails wire deserializer',
  behavior: 'Deserializes bridge user wire payload into InternalUserDetails and provider structures.',
  featureKeys: ['InternalUserDetails'],
  flipped: 'unit-backed',
});
