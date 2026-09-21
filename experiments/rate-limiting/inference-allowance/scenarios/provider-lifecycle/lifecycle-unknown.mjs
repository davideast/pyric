export default {
        lifecycle: true, execution: true,
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 3 },
        provider: { requests: { held: { delayMs: 900, unknownAfterMs: 150 } } },
        schedule: [
            { id: 'held', uid: 'alice', atMs: 0 },
            { id: 'retry', requestId: 'held', uid: 'alice', atMs: 350 },
            { id: 'other', uid: 'bob', atMs: 400 },
            { id: 'later', uid: 'alice', atMs: 1100 },
        ],
        expected: { held: 'outcome_unknown', retry: 'execution_busy', other: 'completed', later: 'execution_busy' },
        unknown: ['held'],
    };
