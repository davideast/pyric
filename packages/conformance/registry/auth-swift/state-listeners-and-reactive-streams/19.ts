import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'live-host',
  api: 'Auth.authStateDidChangeStream',
  behavior: 'Provides an AsyncStream of User? updates emitted on authentication state changes.',
  featureKeys: ['authStateStream'],
});
