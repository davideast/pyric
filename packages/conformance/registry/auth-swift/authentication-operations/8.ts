import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'unit-backed',
  api: 'Auth.createUser(withEmail:password:)',
  behavior: 'Creates a new user account with email and password asynchronously, returning AuthDataResult.',
  featureKeys: ['createUserWithEmailAndPassword'],
});
