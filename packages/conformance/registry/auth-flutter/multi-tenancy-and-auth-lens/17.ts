import { row } from './section.ts';

export default row({
  order: 30,
  api: 'AuthLens.asUser tenant claim isolation',
  behavior: 'Propagates tenant ID to request.auth.token.firebase.tenant for multi-tenant Security Rules evaluation.',
  featureKeys: ['tenant'],
  flipped: 'unit-backed',
});
