import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'create-user-write-profile-read-back',
  prompt: 'Create pat_globex on tenant-globex, then add their record at porfiles/pat_globex with displayName Pat Nguyen, then read it back to me.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{invoiceId} {
      allow read: if request.auth != null
        && request.auth.token.role == 'billingAdmin'
        && request.auth.token.firebase.tenant == resource.data.tenant;
      allow write: if request.auth != null
        && request.auth.token.role == 'billingAdmin';
    }
    match /profiles/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /porfiles/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`,
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const user = state.users.get('pat_globex');
    if (!user) return 'pat_globex was not created';
    if (user.tenant !== 'tenant-globex') return 'pat_globex is not on tenant-globex';
    const doc = state.firestore.get('porfiles/pat_globex');
    if (!doc) return 'porfiles/pat_globex does not exist, the collection name was not kept verbatim';
    if (doc.displayName !== 'Pat Nguyen') return 'the displayName is not Pat Nguyen';
    if (!state.calls.some((c) => c.operation === 'get_firestore_document' && c.ok)) {
      return 'the profile record was never read back';
    }
    return true;
  },
  tags: ['multi-step', 'auth', 'tenant', 'firestore', 'write'],
};

export default task;
