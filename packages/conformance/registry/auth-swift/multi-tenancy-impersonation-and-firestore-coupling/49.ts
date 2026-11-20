import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'unit-backed',
  api: 'Auth.currentAuthLens()',
  behavior: 'Computes the effective AuthLens based on active impersonation or currentUser state.',
  featureKeys: ['currentAuthLens'],
});
