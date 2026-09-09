import type { EvalCall, EvalTask } from '../types.js';

/**
 * The cursor a call named, under either variant's argument shape: the service
 * tools nest the method's arguments, the discriminator tools do not.
 */
function cursorNamed(call: EvalCall): string | null {
  const nested = call.args.args as Record<string, unknown> | undefined;
  const since = nested?.since ?? call.args.since;
  return typeof since === 'string' ? since : null;
}

/** The cursor a call handed back for the next page, when it handed one back. */
function cursorReturned(call: EvalCall): string | null {
  const data = call.data as { nextCursor?: unknown } | undefined;
  return typeof data?.nextCursor === 'string' ? data.nextCursor : null;
}

const task: EvalTask = {
  id: 'page-through-events-after-a-burst',
  prompt:
    'I want to see the sandbox operation log. Create three quick test documents in the scratch collection, then show me the log two events at a time, picking the second page up where the first one ended.',
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

    // Two calls that both start from the top are one page read twice, so what
    // makes this paging is the second call continuing from the first's cursor.
    const handedOn = cursorReturned(pages[0]!);
    if (handedOn === null) return 'the first page returned no cursor to continue from';
    const continued = pages.some((page) => cursorNamed(page) === handedOn);
    if (!continued) return 'no later page continued from the cursor the first page returned';
    return true;
  },
  tags: ['sandbox', 'read', 'multi-step'],
};

export default task;
