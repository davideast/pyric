import type { EvalTask } from '../types.js';

/** The instant the task pins the clock to, in epoch milliseconds. */
const PINNED = Date.parse('2026-06-01T00:00:00.000Z');

/**
 * The epoch milliseconds a stored stamp carries, or null when the field holds
 * something that is not a timestamp.
 */
function instantOf(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null;
  const seconds = (value as { seconds?: unknown }).seconds;
  if (typeof seconds !== 'number') return null;
  const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
  const fraction = typeof nanoseconds === 'number' ? nanoseconds : 0;
  return seconds * 1000 + Math.floor(fraction / 1_000_000);
}

const task: EvalTask = {
  id: 'freeze-time-write-two-documents-same-timestamp',
  prompt:
    'Freeze the clock at 2026-06-01T00:00:00.000Z, then write ledger/first and ledger/second, each stamped with a server timestamp, and prove they carry the same instant.',
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
    // A stamp read back from the sandbox is a Timestamp, so it is compared by
    // the instant it carries. Both must be the pin: a task that wrote the
    // instant as a literal would satisfy an equality check between the two
    // documents and prove nothing about the clock.
    const firstAt = instantOf(first.at);
    const secondAt = instantOf(second.at);
    if (firstAt === null || secondAt === null) {
      return 'a document is missing its stamped instant, or the instant is not a timestamp';
    }
    if (firstAt !== secondAt) return 'the two documents do not carry the same instant';
    if (firstAt !== PINNED) {
      return 'the stamped instant is not the instant the clock was pinned to';
    }
    return true;
  },
  tags: ['sandbox', 'write', 'multi-step'],
};

export default task;
