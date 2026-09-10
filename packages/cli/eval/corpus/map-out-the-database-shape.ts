import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'map-out-the-database-shape',
  prompt:
    "I've inherited this project and have never seen the database before. What collections and documents actually exist in the sandbox right now?",
  seed: {
    firestore: {
      'orgs/org-a': { name: 'Org A' },
      'orgs/org-b': { name: 'Org B' },
      'orgs/org-a/teams/team-1': { name: 'Team One' },
    },
  },
  acceptedFirstOperations: ['discover_firestore_paths'],
  assert: (state) => {
    const discovered = state.calls.find((c) => c.operation === 'discover_firestore_paths' && c.ok);
    if (!discovered) return 'the database was never surveyed for its collection shape';
    const collections = (
      discovered.data as { collections?: Array<{ path: string }> } | undefined
    )?.collections;
    if (collections !== undefined && !collections.some((entry) => entry.path === 'orgs')) {
      return 'the orgs collection did not show up in the discovered paths';
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
