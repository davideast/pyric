import { unsafeAdmit } from '../architecture/unsafe-admission.mjs';
import { quotaPath } from '../architecture/admission.mjs';
export const contention = {
    'portable-burst': {
        checks: ['allowance conserved for both users', 'dispatches do not exceed charges', 'dispatches unique per user request', 'all responses classified', 'contending user makes progress', 'other user makes progress'],
        async run({ send, secondSend, check, store, events, record, gateway, secondGateway }) {
            const requests = [...Array.from({ length: 50 }, (_, i) => ({ uid: 'alice', requestId: `burst-${i}` })),
                ...Array.from({ length: 5 }, (_, i) => ({ uid: 'bob', requestId: `normal-${i}` }))];
            const replies = await Promise.all(requests.map((r, i) => (i % 2 ? secondSend : send)(r.uid, 'chat', { requestId: r.requestId })));
            await gateway.drain();
            await secondGateway.drain();
            const users = {};
            for (const uid of ['alice', 'bob']) {
                const statuses = replies.filter((_, i) => requests[i].uid === uid).map(r => r.status);
                const saved = await store.get(quotaPath(uid));
                const remaining = saved?.buckets?.chat?.remaining ?? 300000;
                users[uid] = { requests: statuses.length, completed: statuses.filter(s => s === 'completed').length,
                    quotaExhausted: statuses.filter(s => s === 'quota_exhausted').length,
                    failures: statuses.filter(s => s === 'backend_failure').length,
                    timeouts: statuses.filter(s => s === 'admission_timeout').length,
                    unknown: statuses.filter(s => s === 'outcome_unknown').length,
                    dispatches: events.filter(e => e.kind === 'inference-dispatch' && e.uid === uid).length,
                    charged: (300000 - remaining) / 60000 };
            }
            const dispatches = events.filter(e => e.kind === 'inference-dispatch');
            check('allowance conserved for both users', Object.values(users).every(u => Number.isInteger(u.charged) && u.charged >= 0 && u.charged <= 5), true);
            check('dispatches do not exceed charges', Object.values(users).every(u => u.dispatches <= u.charged), true);
            check('dispatches unique per user request', new Set(dispatches.map(e => `${e.uid}/${e.requestId}`)).size, dispatches.length);
            check('all responses classified', replies.every(r => ['completed', 'quota_exhausted', 'backend_failure', 'admission_timeout', 'outcome_unknown'].includes(r.status)), true);
            check('contending user makes progress', users.alice.completed > 0, true);
            check('other user makes progress', users.bob.completed > 0, true);
            record('contention-observation', { users, transactionAttempts: events.filter(e => e.kind === 'transaction-attempt').length,
                retryAttempts: events.filter(e => e.kind === 'transaction-attempt' && e.attempt > 1).length });
        },
    },
    'burst-50': {
        checks: ['five admissions', 'remaining requests denied', 'saved balance zero', 'transaction retries observed'],
        async run({ send, check, store, events }) {
            const replies = await Promise.all(Array.from({ length: 50 }, () => send()));
            check('five admissions', replies.filter(r => r.status === 'completed').length, 5);
            check('remaining requests denied', replies.filter(r => r.status === 'quota_exhausted').length, 45);
            check('saved balance zero', (await store.get(quotaPath('alice'))).buckets.chat.remaining, 0);
            check('transaction retries observed', events.some(e => e.kind === 'transaction-attempt' && e.attempt > 1), true);
        },
    },
    'unsafe-burst': {
        negative: ['allowance respected'], checks: ['allowance respected', 'overspending reproduced'],
        options: { admission: unsafeAdmit },
        async run({ send, check }) {
            const replies = await Promise.all(Array.from({ length: 50 }, () => send()));
            const count = replies.filter(r => r.status === 'completed').length;
            check('allowance respected', count <= 5, true, false);
            check('overspending reproduced', count, 50);
        },
    },
    duplicates: {
        checks: ['one dispatch', 'one charge', 'changed payload rejected', 'duplicate does not redispatch'],
        async run({ send, check, store, events }) {
            await Promise.all(Array.from({ length: 10 }, () => send('alice', 'chat', { requestId: 'same' })));
            check('one dispatch', events.filter(e => e.kind === 'inference-dispatch').length, 1);
            check('one charge', (await store.get(quotaPath('alice'))).buckets.chat.remaining, 240000);
            check('changed payload rejected', (await send('alice', 'chat', { requestId: 'same', prompt: 'changed' })).status, 'conflict');
            await send('alice', 'chat', { requestId: 'same' });
            check('duplicate does not redispatch', events.filter(e => e.kind === 'inference-dispatch').length, 1);
        },
    },
};
