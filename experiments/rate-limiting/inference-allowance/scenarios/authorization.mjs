import { quotaPath } from '../architecture/admission.mjs';
export const authorization = {
    authorization: {
        requires: ['clientRules'],
        checks: ['signed out rejected', 'forged UID rejected', 'unknown category rejected', 'unknown model rejected', 'client quota edits denied', 'no inference'],
        async run({ send, gateway, store, check, events }) {
            check('signed out rejected', (await send('outsider')).status, 'unauthenticated');
            check('forged UID rejected', (await send('alice', 'chat', { uid: 'bob' })).status, 'invalid_request');
            check('unknown category rejected', (await send('alice', 'free')).status, 'invalid_request');
            check('unknown model rejected', (await send('alice', 'chat', { model: 'free-model' })).status, 'invalid_request');
            let denied = false;
            try {
                await store.clientPut('alice', quotaPath('alice'), { policyVersion: 1, buckets: {} });
            }
            catch (error) {
                denied = error.code === 'permission-denied';
            }
            check('client quota edits denied', denied, true);
            check('no inference', events.filter(e => e.kind === 'inference-dispatch').length, 0);
        },
    },
    malformed: {
        checks: ['negative balance denied', 'null bucket denied', 'missing buckets denied', 'policy mismatch denied', 'no inference'],
        async run({ send, store, check, events }) {
            await store.put(quotaPath('alice'), { policyVersion: 1, buckets: { chat: { remaining: -1, updatedAt: 1000000 } } });
            check('negative balance denied', (await send()).status, 'backend_failure');
            await store.put(quotaPath('alice'), { policyVersion: 1, buckets: { chat: null } });
            check('null bucket denied', (await send()).status, 'backend_failure');
            await store.put(quotaPath('alice'), { policyVersion: 1 });
            check('missing buckets denied', (await send()).status, 'backend_failure');
            await store.put(quotaPath('alice'), { policyVersion: 2, buckets: {} });
            check('policy mismatch denied', (await send()).status, 'backend_failure');
            check('no inference', events.filter(e => e.kind === 'inference-dispatch').length, 0);
        },
    },
};
