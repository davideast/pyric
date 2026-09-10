import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'average-rating-across-reviews',
  prompt: 'What is the average star rating across every review we have collected so far?',
  seed: {
    firestore: {
      'reviews/r1': { rating: 4 },
      'reviews/r2': { rating: 2 },
      'reviews/r3': { rating: 6 },
    },
  },
  acceptedFirstOperations: ['aggregate_firestore_documents', 'count_firestore_documents'],
  assert: (state) => {
    const aggregated = state.calls.find(
      (c) => c.operation === 'aggregate_firestore_documents' && c.ok,
    );
    if (!aggregated) return 'reviews was never aggregated for an average';
    const average = (aggregated.data as { average?: number } | undefined)?.average;
    if (average !== undefined && average !== 4) return `average was ${average}, not 4`;
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
