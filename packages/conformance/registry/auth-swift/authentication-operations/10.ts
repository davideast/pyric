import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'live-host',
  api: 'Auth.signInAnonymously()',
  behavior: 'Signs in as an anonymous user asynchronously, returning AuthDataResult.',
  featureKeys: ['signInAnonymously'],
});
