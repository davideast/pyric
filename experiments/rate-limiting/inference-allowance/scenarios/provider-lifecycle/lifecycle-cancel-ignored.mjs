import { options, recoverySchedule, recoveryExpected } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: { requests: { held: { delayMs: 900, cancellation: 'ignore', abortTransport: true } } },
        schedule: [...recoverySchedule, { id: 'cancel', uid: 'alice', atMs: 180, operation: 'cancel', requestId: 'held' }],
        expected: { held: 'cancellation_requested', cancel: 'cancellation_requested', ...recoveryExpected },
        cancellation: { requested: 1, confirmed: 0 },
    };
