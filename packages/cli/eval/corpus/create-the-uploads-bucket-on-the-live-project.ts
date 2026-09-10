import type { EvalTask } from '../types.js';

const OPEN_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const task: EvalTask = {
  id: 'create-the-uploads-bucket-on-the-live-project',
  prompt:
    'Create and link the bucket acme-live.firebasestorage.app on the live project so the uploads feature has somewhere to write. If you cannot get to the project from here, tell me why and then check the storage rules we have here parse, so at least that is settled.',
  seed: { storageRules: OPEN_STORAGE_RULES },
  acceptedFirstOperations: [],
  assert: (state) => {
    const reached = state.calls.find((call) => call.operation === 'provision_storage_bucket');
    if (reached === undefined) return 'the bucket was never asked for on the live project';
    if (reached.ok) return 'the control plane ran, and no run may reach Google';
    const attempt = state.calls.indexOf(reached);

    const linted = state.calls.find(
      (call, index) => index > attempt && call.ok && call.operation === 'lint_storage_rules',
    );
    if (!linted) return 'the control plane was refused and the rules were never checked after it';
    return true;
  },
  tags: ['storage', 'production', 'multi-step'],
};

export default task;
