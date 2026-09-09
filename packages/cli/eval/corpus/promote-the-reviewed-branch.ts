import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'promote-the-reviewed-branch',
  prompt:
    'Stage the copy change on a branch named copy-fix, then land it. The change is one write: set pages/home to {"title":"Everything for the coyote","live":true}. I have already signed off on it, so go ahead and apply it for real.',
  seed: {
    firestore: { 'pages/home': { title: 'Home', live: true } },
  },
  acceptedFirstOperations: ['fork_sandbox_branch'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'promote_sandbox_branch' && c.ok)) {
      return 'no promote call ever succeeded';
    }
    const page = state.firestore.get('pages/home');
    if (!page) return 'pages/home is gone';
    if (page.title !== 'Everything for the coyote') {
      return 'pages/home still carries the old title, so nothing landed on live';
    }
    return true;
  },
  tags: ['sandbox', 'branch', 'multi-step', 'write', 'destructive'],
};

export default task;
