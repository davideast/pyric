import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'unit-backed',
  api: 'AuthDataResult.additionalUserInfo',
  behavior: 'Returns AdditionalUserInfo containing provider ID and isNewUser flag.',
  featureKeys: ['additionalUserInfo'],
});
