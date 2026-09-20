import { options } from '../../fixtures/provider-lifecycle.mjs';
export default {
        options: { ...options, inferenceTimeoutMs: 600 },
        provider: { requests: { held: { delayMs: 100, resultMode: 'pending' } } },
        schedule: [{ id: 'held', uid: 'alice', atMs: 0 }, { id: 'recovered', uid: 'alice', atMs: 350 }],
        expected: { held: 'inference_timeout', recovered: 'completed' },
    };
