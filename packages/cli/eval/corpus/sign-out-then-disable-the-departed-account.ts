import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'sign-out-then-disable-the-departed-account',
  prompt:
    'Sign the app out, then disable morgan@example.test since they left the company. Administration should still work with nobody signed in.',
  seed: {
    users: [
      { uid: 'morgan', email: 'morgan@example.test', password: 'hunter22' },
      { uid: 'jules', email: 'jules@example.test', password: 'hunter22' },
    ],
  },
  acceptedFirstOperations: ['signout_auth_session', 'signin_auth_password'],
  assert: (state) => {
    if (!state.calls.some((call) => call.operation === 'signout_auth_session' && call.ok)) {
      return 'the app was never signed out';
    }
    if (!state.calls.some((call) => call.operation === 'update_auth_user' && call.ok)) {
      return 'the account was never changed after the sign-out';
    }
    if (state.users.get('morgan') === null) return 'the account is gone rather than disabled';
    return true;
  },
  tags: ['auth', 'identity', 'multi-step'],
};

export default task;
