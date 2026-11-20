import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'live-host',
  api: 'AuthDataResult.additionalUserInfo',
  behavior: 'Returns AdditionalUserInfo containing provider ID and isNewUser flag.',
  featureKeys: ['additionalUserInfo'],
});
