import { scheduledRequests } from '../harness/scheduler.mjs';
import { sleep } from '../harness/faults.mjs';
import { quotaPath } from '../architecture/admission.mjs';
const flood = guarded => ({
    checks: ['normal users complete', 'flood stays within allowance', 'outstanding work drains', ...(guarded ? ['guard sheds requests'] : [])],
    options: guarded ? { maxOutstandingPerUid: 2 } : {},
    fault: () => async (point, info) => {
        if (point === 'beforeRead' && info.phase === 'admission' && info.uid === 'alice')
            await sleep(3);
    },
    async run({ send, gateway, check, record, events }) {
        const schedule = Array.from({ length: 60 }, (_, i) => ({ id: `flood-${i}`, uid: 'alice', atMs: Math.floor(i / 10) * 3 }));
        schedule.push(...Array.from({ length: 5 }, (_, i) => ({ id: `normal-${i}`, uid: 'bob', atMs: i * 4 })));
        const replies = await scheduledRequests(schedule, item => send(item.uid, 'chat', { requestId: item.id }), record);
        await gateway.drain();
        check('normal users complete', replies.slice(60).map(r => r.status), Array(5).fill('completed'));
        check('flood stays within allowance', events.filter(e => e.kind === 'inference-dispatch' && e.uid === 'alice').length <= 5, true);
        const last = Object.fromEntries(events.filter(e => e.kind === 'outstanding').map(e => [e.uid, e.value]));
        check('outstanding work drains', Object.values(last).every(n => n === 0), true);
        if (guarded)
            check('guard sheds requests', replies.some(r => r.status === 'admission_busy'), true);
    },
});
export const overload = {
    flood: flood(false), 'guarded-flood': flood(true),
    'multi-gateway': {
        checks: ['shared allowance respected', 'both instances observed', 'duplicate across instances charged once'],
        async run({ send, secondSend, check, events, store }) {
            await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? send : secondSend)('alice', 'chat', { requestId: `shared-${i}` })));
            check('shared allowance respected', events.filter(e => e.kind === 'inference-dispatch').length, 5);
            check('both instances observed', new Set(events.filter(e => e.kind === 'request-start').map(e => e.instanceId)).size, 2);
            await Promise.all([send('bob', 'chat', { requestId: 'duplicate' }), secondSend('bob', 'chat', { requestId: 'duplicate' })]);
            check('duplicate across instances charged once', (await store.get(quotaPath('bob'))).buckets.chat.remaining, 240000);
        },
    },
    'retry-exhaustion': {
        maxAttempts: 1, checks: ['some native transactions fail', 'allowance never exceeded', 'inference requires admission'],
        async run({ send, check, events }) {
            const replies = await Promise.all(Array.from({ length: 50 }, () => send()));
            check('some native transactions fail', replies.some(r => r.status === 'backend_failure'), true);
            check('allowance never exceeded', events.filter(e => e.kind === 'inference-dispatch').length <= 5, true);
            const admitted = new Set(events.filter(e => e.kind === 'admission-decision' && e.status === 'admitted').map(e => e.requestId));
            check('inference requires admission', events.filter(e => e.kind === 'inference-dispatch').every(e => admitted.has(e.requestId)), true);
        },
    },
};
