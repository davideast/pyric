import { options } from '../../fixtures/provider-lifecycle.mjs';
export default {
    options,
    provider: { requests: { held: { delayMs: 100, terminalOutcome: 'cancelled' } } },
    schedule: [{ id: 'held', uid: 'alice', atMs: 0 }, { id: 'recovered', uid: 'alice', atMs: 350 }],
    expected: { held: 'provider_cancelled', recovered: 'completed' },
    cancellation: { requested: 0, confirmed: 1 },
};
