import { row } from './section.ts';

export default row({
  order: 80,
  api: 'UserPlatform.tenantId',
  behavior: 'Exposes Google Cloud Identity Platform tenant ID associated with user.',
  featureKeys: ['tenantId'],
  flipped: 'unit-backed',
});
