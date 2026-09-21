import { options, recoverySchedule, recoveryExpected } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: { requests: { held: { delayMs: 900, chunks: 3 } } },
        schedule: recoverySchedule.map(item => item.id === 'held' ? { ...item, stream: true } : item),
        expected: { held: 'completed', ...recoveryExpected }, chunks: [0, 1, 2],
    };
