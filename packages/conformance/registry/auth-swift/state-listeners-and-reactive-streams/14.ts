import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'unit-backed',
  api: 'Auth.currentUser',
  behavior: 'Returns the currently authenticated User, or nil if no user is signed in.',
  featureKeys: ['currentUser'],
});
