import { row } from './section.ts';

export default row({
  order: 100,
  flipped: 'unit-backed',
  api: 'User.tenant',
  behavior: 'Returns the tenant identifier associated with the user in multi-tenant configurations.',
  featureKeys: ['tenant'],
});
