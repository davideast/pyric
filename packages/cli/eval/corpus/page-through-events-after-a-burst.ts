import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'page-through-events-after-a-burst',
  prompt:
    'I want to see the sandbox operation log. Create three quick test documents in the scratch collection, then show me the log two events at a time, starting from the most recent page.',
  seed: {},
  acceptedFirstOperations: [
    'add_firestore_document',
    'write_firestore_document',
    'update_firestore_document',
  ],
  assert: (state) => {
    const pages = state.calls.filter((c) => c.operation === 'list_sandbox_events' && c.ok);
    if (pages.length < 2) return 'the event log was not paged at least twice';
    const writes = state.calls.filter(
      (c) =>
        c.ok &&
        (c.operation === 'add_firestore_document' ||
          c.operation === 'write_firestore_document' ||
          c.operation === 'update_firestore_document'),
    );
    if (writes.length < 3) return 'fewer than three documents were written';
    return true;
  },
  tags: ['sandbox', 'read', 'multi-step'],
};

export default task;
