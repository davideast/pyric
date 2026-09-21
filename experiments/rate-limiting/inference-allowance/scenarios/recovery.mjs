import { quotaPath } from '../architecture/admission.mjs';
import { onceAt, sleep } from '../harness/faults.mjs';
const dispatches = events => events.filter(e => e.kind === 'inference-dispatch').length;
export const recovery = {
    'authentication-timeout': {
        checks: ['auth deadline returned', 'no late transaction', 'no late inference'],
        options: { deadlineMs: 10 },
        setup() {
            let releaseIdentity;
            const identity = new Promise(resolve => { releaseIdentity = resolve; });
            return { authenticate: () => identity, releaseIdentity };
        },
        async run({ send, gateway, releaseIdentity, check, events }) {
            const reply = await send();
            releaseIdentity('alice');
            await gateway.drain();
            check('auth deadline returned', reply.status, 'admission_timeout');
            check('no late transaction', events.some(e => e.kind === 'transaction-attempt'), false);
            check('no late inference', dispatches(events), 0);
        },
    },
    'before-commit-failure': {
        checks: ['failure returned', 'no dispatch', 'no charge', 'retry succeeds'],
        fault: () => onceAt('admission', 'beforeCommit'),
        async run({ send, store, check, events }) {
            check('failure returned', (await send('alice', 'chat', { requestId: 'retry' })).status, 'backend_failure');
            check('no dispatch', dispatches(events), 0);
            check('no charge', await store.get(quotaPath('alice')), null);
            check('retry succeeds', (await send('alice', 'chat', { requestId: 'retry' })).status, 'completed');
        },
    },
    'commit-ack-lost': {
        checks: ['uncertain outcome', 'no premature dispatch', 'retry resumes admission', 'charged once', 'dispatched once'],
        fault: () => onceAt('admission', 'afterCommit'),
        async run({ send, store, check, events }) {
            check('uncertain outcome', (await send('alice', 'chat', { requestId: 'retry' })).status, 'outcome_unknown');
            check('no premature dispatch', dispatches(events), 0);
            check('retry resumes admission', (await send('alice', 'chat', { requestId: 'retry' })).status, 'completed');
            check('charged once', (await store.get(quotaPath('alice'))).buckets.chat.remaining, 240000);
            check('dispatched once', dispatches(events), 1);
        },
    },
    'dispatch-ack-lost': {
        checks: ['uncertain claim', 'no premature inference', 'retry does not reclaim dispatch', 'no dispatch after retry', 'allowance retained'],
        fault: () => onceAt('dispatch', 'afterCommit'),
        async run({ send, check, events, store }) {
            check('uncertain claim', (await send('alice', 'chat', { requestId: 'retry' })).status, 'outcome_unknown');
            check('no premature inference', dispatches(events), 0);
            check('retry does not reclaim dispatch', (await send('alice', 'chat', { requestId: 'retry' })).status, 'duplicate');
            check('no dispatch after retry', dispatches(events), 0);
            check('allowance retained', (await store.get(quotaPath('alice'))).buckets.chat.remaining, 240000);
        },
    },
    'admission-timeout': {
        checks: ['timeout returned', 'no late dispatch', 'no late charge', 'subsequent request succeeds'],
        options: { deadlineMs: 10 }, fault: () => onceAt('admission', 'beforeCommit', () => sleep(40)),
        async run({ send, gateway, check, events, store }) {
            check('timeout returned', (await send()).status, 'admission_timeout');
            await gateway.drain();
            check('no late dispatch', dispatches(events), 0);
            check('no late charge', await store.get(quotaPath('alice')), null);
            check('subsequent request succeeds', (await send()).status, 'completed');
        },
    },
    'provider-failure': {
        checks: ['provider outcome uncertain', 'one attempted inference', 'no automatic refund', 'no duplicate inference'], inference: { fail: true },
        async run({ send, check, events, store }) {
            check('provider outcome uncertain', (await send('alice', 'chat', { requestId: 'provider' })).status, 'outcome_unknown');
            check('one attempted inference', dispatches(events), 1);
            check('no automatic refund', (await store.get(quotaPath('alice'))).buckets.chat.remaining, 240000);
            await send('alice', 'chat', { requestId: 'provider' });
            check('no duplicate inference', dispatches(events), 1);
        },
    },
};
