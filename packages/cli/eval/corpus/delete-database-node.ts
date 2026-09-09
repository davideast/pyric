import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'delete-database-node',
  prompt: 'Clear out the whole sessions/expired branch of the realtime database. It is test junk.',
  seed: {
    database: {
      sessions: {
        expired: { s1: { uid: 'alice' }, s2: { uid: 'bob' } },
        active: { s3: { uid: 'alice' } },
      },
    },
  },
  acceptedFirstOperations: ['delete_database_value'],
  assert: (state) => {
    if (state.database.get('sessions/expired')) return 'sessions/expired is still there';
    if (!state.database.get('sessions/active')) return 'sessions/active was removed as well';
    return true;
  },
  tags: ['database', 'write'],
};

export default task;
