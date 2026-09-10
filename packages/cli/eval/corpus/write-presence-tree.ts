import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'write-presence-tree',
  prompt: 'In the realtime database, put alice online at presence/alice with state online and a lastSeen of 1757000000000.',
  seed: {},
  acceptedFirstOperations: ['write_database_value'],
  assert: (state) => {
    const node = state.database.get('presence/alice') as Record<string, unknown> | null;
    if (!node) return 'presence/alice is empty';
    if (node.state !== 'online') return 'presence/alice is not online';
    return true;
  },
  tags: ['database', 'write'],
};

export default task;
