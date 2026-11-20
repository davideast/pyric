import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'unit-backed',
  api: 'Auth.createUser(withEmail:password:completion:)',
  behavior: 'Creates a new user account with email and password using a completion closure.',
  featureKeys: ['createUserWithEmailAndPassword'],
});
