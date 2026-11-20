import { row } from './section.ts';

export default row({
  order: 90,
  api: 'UserPlatform.providerData',
  behavior: 'Provides List<UserInfo> detailing linked authentication providers.',
  featureKeys: ['providerData'],
  flipped: 'unit-backed',
});
