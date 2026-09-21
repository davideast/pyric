import { options, recoverySchedule } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options, provider: { requests: { held: { delayMs: 900, unknownAfterMs: 150 } } },
        legacyTransportControl: true,
        schedule: [recoverySchedule[0], recoverySchedule[1], recoverySchedule[2], recoverySchedule[4]],
        expected: { held: 'outcome_unknown', retry: 'completed', other: 'completed', recovered: 'completed' },
        negative: ['capacity retained until termination', 'remote work respects capacity'],
    };
