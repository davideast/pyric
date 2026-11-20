import { row } from './section.ts';

export default row({
  order: 90,
  flipped: 'live-host',
  api: 'User.providerData',
  behavior: 'Returns an array of UserInfo objects representing linked authentication providers.',
  featureKeys: ['providerData'],
});
