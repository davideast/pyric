import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'live-host',
  api: 'User.getIDTokenResult(forcingRefresh:completion:)',
  behavior: 'Retrieves detailed AuthTokenResult using a completion closure.',
  featureKeys: ['getIdTokenResult'],
});
