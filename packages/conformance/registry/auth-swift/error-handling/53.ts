import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'unit-backed',
  api: 'AuthErrorCode',
  behavior: 'Enumerates standard Firebase Auth error codes (e.g. invalidEmail, wrongPassword, userNotFound).',
  featureKeys: ['authErrorCode'],
});
