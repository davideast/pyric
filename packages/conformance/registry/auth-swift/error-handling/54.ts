import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'unit-backed',
  api: 'AuthError',
  behavior: 'Conforms to LocalizedError and maps wire error codes to structured AuthErrorCode.',
  featureKeys: ['authError'],
});
