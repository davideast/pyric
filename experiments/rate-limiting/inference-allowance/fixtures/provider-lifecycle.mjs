export const options = { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 3 };
export const recoverySchedule = [
    { id: 'held', uid: 'alice', atMs: 0 },
    { id: 'retry', uid: 'alice', atMs: 350 },
    { id: 'other', uid: 'bob', atMs: 450 },
    { id: 'repeat', requestId: 'held', uid: 'alice', atMs: 1100 },
    { id: 'recovered', uid: 'alice', atMs: 1250 },
];
export const recoveryExpected = { retry: 'execution_busy', other: 'completed', repeat: 'duplicate', recovered: 'completed' };
