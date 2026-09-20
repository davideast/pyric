import { options, recoverySchedule, recoveryExpected } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: { requests: { held: { delayMs: 500, cancellation: 'confirm', cancelDelayMs: 650 } } },
        schedule: [...recoverySchedule, { id: 'cancel', uid: 'alice', atMs: 180, operation: 'cancel', requestId: 'held' },
            { id: 'late-cancel', uid: 'alice', atMs: 1050, operation: 'cancel', requestId: 'held' }],
        expected: { held: 'cancellation_requested', cancel: 'cancellation_requested', 'late-cancel': 'not_found', ...recoveryExpected },
        cancellation: { requested: 1, confirmed: 0 },
    };
