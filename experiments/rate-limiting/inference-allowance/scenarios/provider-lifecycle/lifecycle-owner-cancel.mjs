export default {
        lifecycle: true, execution: true,
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 3 },
        provider: { delayMs: 40, delayByRequest: { held: 1000 }, cancellation: 'confirm', cancelDelayMs: 400 },
        schedule: [
            { id: 'held', uid: 'alice', atMs: 0 },
            { id: 'foreign', uid: 'bob', operation: 'cancel', requestId: 'held', atMs: 100 },
            { id: 'signed-out', uid: 'alice', token: 'invalid', operation: 'cancel', requestId: 'held', atMs: 120 },
            { id: 'forged', uid: 'bob', operation: 'cancel', body: { requestId: 'held', uid: 'alice' }, atMs: 140 },
            { id: 'cancel', uid: 'alice', operation: 'cancel', requestId: 'held', atMs: 180 },
            { id: 'cancel-again', uid: 'alice', operation: 'cancel', requestId: 'held', atMs: 220 },
            { id: 'retry', uid: 'alice', atMs: 300 },
            { id: 'repeat', requestId: 'held', uid: 'alice', atMs: 850 },
            { id: 'recovered', uid: 'alice', atMs: 1100 },
        ],
        expected: { foreign: 'not_found', 'signed-out': 'unauthenticated', forged: 'invalid_request', cancel: 'cancellation_requested', 'cancel-again': 'cancellation_requested', held: 'cancellation_requested', retry: 'execution_busy', repeat: 'duplicate', recovered: 'completed' },
    cancellation: { requested: 1, confirmed: 1 },
};
