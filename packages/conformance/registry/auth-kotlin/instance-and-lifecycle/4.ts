import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuth.tenantId',
  behavior: 'Configures and retrieves the tenant ID, updating the active AuthLens to include tenant scope.',
  featureKeys: ['tenantId'],
  flipped: 'live-host',
});
