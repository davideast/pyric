import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'unit-backed',
  api: 'Auth.authLensStream',
  behavior: 'Emits AuthLens updates whenever user transitions occur or impersonation lens changes.',
  featureKeys: ['authLensStream'],
});
