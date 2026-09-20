import { options, recoverySchedule, recoveryExpected } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options: { ...options, inferenceTimeoutMs: 180 },
        provider: { requests: { held: { delayMs: 900, cancellation: 'ignore', abortTransport: true } } },
        schedule: recoverySchedule, expected: { held: 'inference_timeout', ...recoveryExpected },
        cancellation: { requested: 1, confirmed: 0 },
    };
