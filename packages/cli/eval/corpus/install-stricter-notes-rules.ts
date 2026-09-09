import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'install-stricter-notes-rules',
  prompt:
    'The notes collection currently lets anyone read anything, which is wrong. Install rules that only let the owner read their own note, then confirm alice can no longer read notes/private1, which belongs to bob.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow read, write: if true;
    }
  }
}
`,
    users: [
      { uid: 'alice', email: 'alice@example.test' },
      { uid: 'bob', email: 'bob@example.test' },
    ],
    firestore: {
      'notes/private1': { owner: 'bob', text: 'do not share' },
    },
  },
  acceptedFirstOperations: ['set_firestore_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'set_firestore_rules' && c.ok)) {
      return 'a stricter ruleset was never installed';
    }
    if (!state.calls.some((c) => c.operation === 'simulate_firestore_rules' && c.ok)) {
      return "alice's read of notes/private1 was never checked against the installed rules";
    }
    return true;
  },
  tags: ['multi-step', 'rules', 'firestore', 'set', 'simulate'],
};

export default task;
