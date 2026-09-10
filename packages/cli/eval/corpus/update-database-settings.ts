import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'update-database-settings',
  prompt: 'Change only the theme under settings/acme to dark. The notifications flag under there has to survive.',
  seed: {
    database: {
      settings: { acme: { theme: 'light', notifications: true } },
    },
  },
  acceptedFirstOperations: ['update_database_value'],
  assert: (state) => {
    const node = state.database.get('settings/acme') as Record<string, unknown> | null;
    if (!node) return 'settings/acme is empty';
    if (node.theme !== 'dark') return 'the theme is not dark';
    if (node.notifications !== true) return 'the notifications flag was dropped';
    return true;
  },
  tags: ['database', 'write'],
};

export default task;
