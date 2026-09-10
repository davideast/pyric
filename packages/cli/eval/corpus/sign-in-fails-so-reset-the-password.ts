import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'sign-in-fails-so-reset-the-password',
  prompt:
    'Signing in as pat@example.test with correcthorse keeps failing and I need to reproduce the bug. Find out why, set the password to correcthorse, and get the app signed in.',
  seed: {
    users: [{ uid: 'pat', email: 'pat@example.test', password: 'hunter22' }],
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const attempts = state.calls.filter((call) => call.operation === 'signin_auth_password');
    if (attempts.length === 0) return 'no sign-in was attempted';
    if (!attempts.some((call) => !call.ok)) return 'the failing sign-in was never reproduced';
    if (!state.calls.some((call) => call.operation === 'update_auth_user' && call.ok)) {
      return 'the password was never changed';
    }
    if (!attempts.some((call) => call.ok)) return 'the app never signed in after the change';
    return true;
  },
  tags: ['auth', 'identity', 'recovery', 'multi-step'],
};

export default task;
