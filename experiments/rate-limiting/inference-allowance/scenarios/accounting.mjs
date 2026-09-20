import { quotaPath } from '../architecture/admission.mjs';
export const accounting = {
    refill: {
        checks: ['initial capacity', 'exhausted', 'half token denied', 'exact refill boundary', 'long idle capped', 'backwards clock gives no credit'],
        async run(c) {
            const { send, clock, check } = c;
            const initial = [];
            for (let i = 0; i < 5; i++)
                initial.push((await send('alice', 'chat')).status);
            check('initial capacity', initial, Array(5).fill('completed'));
            check('exhausted', (await send()).status, 'quota_exhausted');
            clock.advance(3000);
            const half = await send();
            check('half token denied', [half.status, half.retryAfterMs], ['quota_exhausted', 3000]);
            clock.advance(3000);
            check('exact refill boundary', (await send()).status, 'completed');
            clock.advance(600000);
            const afterIdle = [];
            for (let i = 0; i < 6; i++)
                afterIdle.push((await send()).status);
            check('long idle capped', afterIdle, [...Array(5).fill('completed'), 'quota_exhausted']);
            clock.advance(-10000);
            check('backwards clock gives no credit', (await send()).status, 'quota_exhausted');
        },
    },
    isolation: {
        checks: ['chat exhausted', 'agent independent', 'other user independent', 'saved balances isolated'],
        async run({ send, store, check }) {
            for (let i = 0; i < 5; i++)
                await send();
            check('chat exhausted', (await send()).status, 'quota_exhausted');
            check('agent independent', (await send('alice', 'agent')).status, 'completed');
            check('other user independent', (await send('bob')).status, 'completed');
            const alice = await store.get(quotaPath('alice')), bob = await store.get(quotaPath('bob'));
            check('saved balances isolated', [alice.buckets.chat.remaining, alice.buckets.agent.remaining, bob.buckets.chat.remaining], [0, 60000, 240000]);
        },
    },
};
