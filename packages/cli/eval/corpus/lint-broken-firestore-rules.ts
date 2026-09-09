import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'lint-broken-firestore-rules',
  prompt: 'Lint these rules for me. Something is off in the posts block and the deploy keeps failing.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow create: if request.auth.uid == resource.data.ownerId;
      allow read: if true
    }
    match /{document=**} {
      allow read: if request.auth != null;
    }
  }
}
`,
  },
  acceptedFirstOperations: ['lint_firestore_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'lint_firestore_rules' && c.ok)) {
      return 'the Firestore rules were never linted';
    }
    return true;
  },
  tags: ['rules', 'firestore', 'lint'],
};

export default task;
