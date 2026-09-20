import { options, recoverySchedule } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: { requests: { held: { delayMs: 900, chunks: 4, unknownAfterMs: 300 } } },
        schedule: recoverySchedule.map(item => item.id === 'held' ? { ...item, stream: true } : item),
        expected: { held: 'outcome_unknown', retry: 'execution_busy', other: 'completed', repeat: 'execution_busy', recovered: 'execution_busy' },
        unknown: ['held'], chunks: [0],
    };
