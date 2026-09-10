import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'fix-and-install-database-rules',
  prompt:
    'These Realtime Database rules deny every read, which is not what we want. Fix them so a signed-in user can read rooms/lobby, install the fix, and then confirm dana can read it.',
  seed: {
    databaseRules: JSON.stringify({ rules: { '.read': false, '.write': false } }),
    users: [{ uid: 'dana', email: 'dana@example.test' }],
    database: { rooms: { lobby: { open: true } } },
  },
  acceptedFirstOperations: ['set_database_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'set_database_rules' && c.ok)) {
      return 'the fixed database rules were never installed';
    }
    if (!state.calls.some((c) => c.operation === 'simulate_database_rules' && c.ok)) {
      return "dana's read of rooms/lobby was never checked against the installed rules";
    }
    return true;
  },
  tags: ['multi-step', 'rules', 'database', 'set', 'simulate'],
};

export default task;
