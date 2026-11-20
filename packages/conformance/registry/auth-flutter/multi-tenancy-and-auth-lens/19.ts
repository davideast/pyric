import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Firestore snapshot re-subscription supervisor',
  behavior: 'Automatically re-subscribes active Firestore snapshot listeners under the new AuthLens upon auth transition.',
  featureKeys: ['snapshots', 'authLens'],
  flipped: 'unit-backed',
});
