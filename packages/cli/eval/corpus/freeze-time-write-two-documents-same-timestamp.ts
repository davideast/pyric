import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'freeze-time-write-two-documents-same-timestamp',
  prompt:
    'Freeze the clock, then write ledger/first and ledger/second, each stamped with the current instant, and prove they carry the same timestamp.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`,
  },
  acceptedFirstOperations: ['set_clock'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'set_clock' && c.ok)) {
      return 'the clock was never pinned';
    }
    const first = state.firestore.get('ledger/first');
    const second = state.firestore.get('ledger/second');
    if (first === null || second === null) return 'both documents were not written';
    if (first.at === undefined || second.at === undefined) {
      return 'a document is missing its stamped instant';
    }
    if (first.at !== second.at) return 'the two documents do not carry the same timestamp';
    return true;
  },
  tags: ['sandbox', 'write', 'multi-step'],
};

export default task;
