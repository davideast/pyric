import { options, recoverySchedule } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: {}, delay: { boundary: 'beforeRead', uid: 'alice', requestIds: ['held'], durationMs: 700 },
        schedule: [recoverySchedule[0], recoverySchedule[1], recoverySchedule[2], recoverySchedule[4],
            { id: 'cancel', uid: 'alice', atMs: 180, operation: 'cancel', requestId: 'held' }],
        expected: { held: 'cancellation_requested', cancel: 'cancellation_requested', retry: 'execution_busy', other: 'completed', recovered: 'completed' },
        noDispatch: ['held'], cancellation: { requested: 0, confirmed: 0 },
    };
