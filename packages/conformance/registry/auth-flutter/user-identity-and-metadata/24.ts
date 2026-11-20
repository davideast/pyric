import { row } from './section.ts';

export default row({
  order: 50,
  api: 'UserPlatform.phoneNumber',
  behavior: 'Returns associated phone number or null if unset.',
  featureKeys: ['phoneNumber'],
  flipped: 'unit-backed',
});
