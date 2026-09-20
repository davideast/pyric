import { options, recoverySchedule, recoveryExpected } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: { requests: { held: { delayMs: 900, cancellation: 'ignore', abortTransport: true, chunks: 4 } } },
        schedule: recoverySchedule.map(item => item.id === 'held' ? { ...item, stream: true, disconnectOnChunk: true } : item),
        expected: recoveryExpected, disconnected: ['held'], chunks: [0],
        cancellation: { requested: 1, confirmed: 0 },
    };
