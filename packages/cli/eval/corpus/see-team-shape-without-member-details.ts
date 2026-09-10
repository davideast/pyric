import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'see-team-shape-without-member-details',
  prompt:
    'Without dumping every field, show me how teams is structured in the realtime database: which teams exist and roughly how many members each has.',
  seed: {
    database: {
      teams: {
        alpha: { members: { u1: 'joined', u2: 'joined' } },
        beta: { members: { u3: 'joined' } },
      },
    },
  },
  acceptedFirstOperations: ['crawl_database_structure'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'crawl_database_structure' && c.ok)) {
      return 'teams was never crawled for its structure';
    }
    return true;
  },
  tags: ['database', 'read'],
};

export default task;
