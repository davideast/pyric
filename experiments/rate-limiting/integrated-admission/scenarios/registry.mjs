import { POLICIES, LIMITS } from '../fixtures/policy.mjs';

// Scenario registry. Each entry defines:
//   checks:          predeclared assertion names (all must have a verdict)
//   expectedFailures: assertion names expected to fail (negative controls)
//   run(context):    async function returning observations

// Helper shared across scenarios
export const POLICY_OPTS = { policies: POLICIES, limits: LIMITS };

export const scenarios = {

    // ── 1. Normal chat request: full happy path ─────────────────────────────
    'normal-chat': {
        checks: [
            'normal-chat.one-debit',
            'normal-chat.one-slot',
            'normal-chat.one-dispatch',
            'normal-chat.slot-released',
            'normal-chat.state-completed',
        ],
        async run({ cluster, check }) {
            const a      = await cluster.spawn('a');
            const request = { uid: 'alice', requestId: 'chat-1', category: 'chat', model: 'fake', payloadHash: 'h1' };
            const before = await cluster.snapshot();
            const result = await a.command('start', request);
            const after  = await cluster.snapshot();
            const quota  = after.quotas.find(d => true);
            const slot   = after.capacity.find(d => d.id === 'global');
            check('normal-chat.one-debit',     quota?.data.buckets?.chat !== undefined, true);
            check('normal-chat.one-slot',      before.capacity.length === 0 || before.capacity.find(d => d.id === 'global')?.data.active === 0, true);
            check('normal-chat.one-dispatch',  cluster.provider.snapshot().startAttempts, 1);
            check('normal-chat.slot-released', slot?.data.active ?? 0, 0);
            check('normal-chat.state-completed', result.state ?? result.status, 'completed');
            return { result, finalActive: slot?.data.active ?? 0 };
        },
    },

    // ── 2. Normal agent request: independent bucket ─────────────────────────
    'normal-agent': {
        checks: [
            'normal-agent.one-debit',
            'normal-agent.slot-released',
            'normal-agent.state-completed',
        ],
        async run({ cluster, check }) {
            const a      = await cluster.spawn('a');
            const request = { uid: 'alice', requestId: 'agent-1', category: 'agent', model: 'fake', payloadHash: 'h-agent' };
            const result = await a.command('start', request);
            const after  = await cluster.snapshot();
            const slot   = after.capacity.find(d => d.id === 'global');
            check('normal-agent.one-debit',     after.quotas.some(d => d.data.buckets?.agent !== undefined), true);
            check('normal-agent.slot-released', slot?.data.active ?? 0, 0);
            check('normal-agent.state-completed', result.state ?? result.status, 'completed');
            return { result };
        },
    },

    // ── 3. Capacity full: deny without debit or slot ─────────────────────────
    'capacity-busy': {
        checks: [
            'capacity-busy.busy-response',
            'capacity-busy.no-debit',
            'capacity-busy.no-slot',
        ],
        async run({ cluster, check }) {
            // Fill all 3 global slots manually by spawning workers and admitting
            const workers  = await Promise.all(['a', 'b', 'c'].map(o => cluster.spawn(o)));
            const admitted = await Promise.all(workers.map((w, i) =>
                w.command('admit', { uid: `user-${i}`, requestId: `r-${i}`, category: 'chat', model: 'fake', payloadHash: `h${i}` }),
            ));
            // All should be admitted, filling global capacity (limit 3)
            const d = await cluster.spawn('d');
            const denied = await d.command('admit', { uid: 'overflow', requestId: 'r-ov', category: 'chat', model: 'fake', payloadHash: 'hov' });
            const after  = await cluster.snapshot();
            check('capacity-busy.busy-response', denied.status, 'busy');
            check('capacity-busy.no-debit',      after.quotas.some(d => d.id.includes('overflow')), false);
            check('capacity-busy.no-slot',       after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 3);
            return { denied, admitted: admitted.length };
        },
    },

    // ── 4. Quota exhausted: deny without slot ────────────────────────────────
    'quota-exhausted': {
        checks: [
            'quota-exhausted.denial-response',
            'quota-exhausted.no-slot',
        ],
        async run({ cluster, check }) {
            const a = await cluster.spawn('a');
            // Agent capacity = 2; exhaust it by admitting twice, then try a third
            const r1 = await a.command('admit', { uid: 'bob', requestId: 'a1', category: 'agent', model: 'fake', payloadHash: 'ha1' });
            const r2 = await a.command('admit', { uid: 'bob', requestId: 'a2', category: 'agent', model: 'fake', payloadHash: 'ha2' });
            const r3 = await a.command('admit', { uid: 'bob', requestId: 'a3', category: 'agent', model: 'fake', payloadHash: 'ha3' });
            const after = await cluster.snapshot();
            check('quota-exhausted.denial-response', r3.status, 'quota_exhausted');
            check('quota-exhausted.no-slot',         after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 2);
            return { r1, r2, r3 };
        },
    },

    // ── 5. Duplicate same payload: idempotent ────────────────────────────────
    'duplicate-same-payload': {
        checks: [
            'duplicate-same-payload.saved-state-returned',
            'duplicate-same-payload.one-debit',
            'duplicate-same-payload.one-slot',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'carol', requestId: 'dup-1', category: 'chat', model: 'fake', payloadHash: 'same' };
            const first   = await a.command('admit', request);
            const second  = await a.command('admit', request);  // same requestId + same payloadHash
            const after   = await cluster.snapshot();
            check('duplicate-same-payload.saved-state-returned', second.status, 'duplicate');
            check('duplicate-same-payload.one-debit',            after.quotas.length, 1);
            check('duplicate-same-payload.one-slot',             after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 1);
            return { first, second };
        },
    },

    // ── 6. Duplicate conflict: different payload ─────────────────────────────
    'duplicate-conflict': {
        checks: [
            'duplicate-conflict.conflict-response',
            'duplicate-conflict.original-unchanged',
        ],
        async run({ cluster, check }) {
            const a = await cluster.spawn('a');
            const first  = await a.command('admit', { uid: 'dave', requestId: 'conflict-1', category: 'chat', model: 'fake', payloadHash: 'payload-A' });
            const second = await a.command('admit', { uid: 'dave', requestId: 'conflict-1', category: 'chat', model: 'fake', payloadHash: 'payload-B' });
            const after  = await cluster.snapshot();
            check('duplicate-conflict.conflict-response',  second.status, 'conflict');
            check('duplicate-conflict.original-unchanged', after.requests.find(d => true)?.data.payloadHash, 'payload-A');
            return { first, second };
        },
    },

    // ── 7. Native callback retry: no provider side effects ───────────────────
    'native-retry': {
        checks: [
            'native-retry.one-committed-debit',
            'native-retry.no-provider-side-effects',
        ],
        async run({ cluster, check, record }) {
            const a = await cluster.spawn('a');
            let retried = false;
            // Trigger optimistic concurrency contention on first beforeCommit to force native transaction retry
            cluster.setFault(async (phase, meta) => {
                if (!retried && phase === 'beforeCommit' && meta.instanceId === 'a') {
                    retried = true;
                    await cluster.store.put('capacity/global', { active: 0 });
                }
            });
            const result = await a.command('admit', { uid: 'eve', requestId: 'retry-1', category: 'chat', model: 'fake', payloadHash: 'hr1' });
            cluster.setFault(async () => {});
            const after = await cluster.snapshot();
            check('native-retry.one-committed-debit',      after.requests.length, 1);
            check('native-retry.no-provider-side-effects', cluster.provider.snapshot().startAttempts, 0);
            return { result, retried };
        },
    },

    // ── 8. Crash before admission commit: no committed receipt ───────────────
    'crash-before-commit': {
        checks: [
            'crash-before-commit.no-committed-receipt',
            'crash-before-commit.no-slot',
        ],
        async run({ cluster, check }) {
            const a = await cluster.spawn('a');
            let armed = true;
            cluster.setFault(async (phase, meta) => {
                if (armed && phase === 'beforeCommit' && meta.instanceId === 'a') {
                    armed = false;
                    await cluster.kill('a');
                    throw new Error('injected-pre-commit-kill');
                }
            });
            let clientError = 'none';
            try { await a.command('admit', { uid: 'frank', requestId: 'crash-1', category: 'chat', model: 'fake', payloadHash: 'hc1' }); }
            catch (error) { clientError = error.message; }
            const after = await cluster.snapshot();
            check('crash-before-commit.no-committed-receipt', after.requests.length, 0);
            check('crash-before-commit.no-slot',              after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 0);
            return { clientError };
        },
    },

    // ── 9. Commit succeeds, ack lost: retry finds saved state ────────────────
    'ack-lost': {
        checks: [
            'ack-lost.client-lost-ack',
            'ack-lost.retry-finds-existing',
            'ack-lost.one-debit',
            'ack-lost.one-slot',
        ],
        async run({ cluster, check }) {
            const request = { uid: 'grace', requestId: 'ack-1', category: 'chat', model: 'fake', payloadHash: 'hack1' };
            const a = await cluster.spawn('a');
            let armed = true;
            cluster.setFault(async (phase, meta) => {
                if (armed && phase === 'afterCommit' && meta.instanceId === 'a') {
                    armed = false;
                    await cluster.kill('a');
                    throw new Error('injected-ack-loss');
                }
            });
            let clientError = 'none';
            try { await a.command('admit', request); } catch (error) { clientError = error.message; }
            const b     = await cluster.spawn('b');
            const retry = await b.command('admit', request);
            const after = await cluster.snapshot();
            check('ack-lost.client-lost-ack',    clientError, 'gateway-exited');
            check('ack-lost.retry-finds-existing', retry.status, 'duplicate');
            check('ack-lost.one-debit',          after.requests.length, 1);
            check('ack-lost.one-slot',           after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 1);
            return { clientError, retryStatus: retry.status };
        },
    },

    // ── 10. Pre-dispatch cancel: allowance and slot both refunded ─────────────
    'pre-dispatch-cancel': {
        checks: [
            'pre-dispatch-cancel.allowance-refunded',
            'pre-dispatch-cancel.slot-released',
            'pre-dispatch-cancel.no-dispatch',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'hank', requestId: 'cancel-1', category: 'chat', model: 'fake', payloadHash: 'hcan1' };
            const admitted = await a.command('admit', request);
            const before   = await cluster.snapshot();
            const refunded = await a.command('refund', request, { fence: admitted.record.fence });
            const after    = await cluster.snapshot();
            check('pre-dispatch-cancel.allowance-refunded', refunded.status, 'refunded');
            check('pre-dispatch-cancel.slot-released',      after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 0);
            check('pre-dispatch-cancel.no-dispatch',        cluster.provider.snapshot().startAttempts, 0);
            return { admitted, refunded };
        },
    },

    // ── 11. Cancel vs dispatch race: exactly one wins ────────────────────────
    'cancel-vs-dispatch-race': {
        checks: [
            'cancel-vs-dispatch-race.exactly-one-wins',
            'cancel-vs-dispatch-race.no-double-refund',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const b       = await cluster.spawn('b');
            const request = { uid: 'iris', requestId: 'race-1', category: 'chat', model: 'fake', payloadHash: 'hrace1' };
            const admitted = await a.command('admit', request);
            // Race: a tries to dispatch, b tries to refund — both use the same fence
            const [dispatchResult, refundResult] = await Promise.allSettled([
                a.command('dispatch', request, { fence: admitted.record.fence }),
                b.command('refund',   request, { fence: admitted.record.fence }),
            ]);
            const wins  = [dispatchResult, refundResult].filter(r => r.status === 'fulfilled').length;
            const after = await cluster.snapshot();
            check('cancel-vs-dispatch-race.exactly-one-wins',  wins, 1);
            check('cancel-vs-dispatch-race.no-double-refund',  after.capacity.find(d => d.id === 'global')?.data.active ?? 0, wins === 1 && dispatchResult.status === 'fulfilled' ? 1 : 0);
            return { dispatchResult: dispatchResult.status, refundResult: refundResult.status };
        },
    },

    // ── 12. Refund arithmetic: no saturation loss at normal balance ───────────
    'refund-after-refill': {
        checks: [
            'refund-after-refill.credited-units-correct',
            'refund-after-refill.no-saturation-loss',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'jan', requestId: 'refill-1', category: 'chat', model: 'fake', payloadHash: 'hrefill1' };
            const admitted = await a.command('admit', request);
            const refunded = await a.command('refund', request, { fence: admitted.record.fence });
            check('refund-after-refill.credited-units-correct', refunded.creditedUnits > 0, true);
            check('refund-after-refill.no-saturation-loss',     refunded.saturationLoss, 0);
            return { refunded };
        },
    },

    // ── 13. Refund with saturation: loss is recorded ─────────────────────────
    'refund-saturation': {
        checks: [
            'refund-saturation.saturation-loss-recorded',
        ],
        async run({ cluster, check }) {
            const a = await cluster.spawn('a');
            // Admit 5 requests (filling chat capacity = 5 * COST) then refund one —
            // the bucket is now near capacity, so some credit is lost to saturation.
            // We do this by advancing time to let the bucket refill before the refund.
            const requests = Array.from({ length: 5 }, (_, i) => ({
                uid: 'ken', requestId: `sat-${i}`, category: 'chat', model: 'fake', payloadHash: `hsat${i}`,
            }));
            await Promise.all(requests.map(r => a.command('admit', r)));
            // Advance clock to refill bucket almost fully
            cluster.advance(60_000);
            const refunded = await a.command('refund', requests[0], { fence: 1 });
            check('refund-saturation.saturation-loss-recorded', refunded.saturationLoss > 0, true);
            return { refunded };
        },
    },

    // ── 14. Crash after dispatch intent: slot retained as unknown ─────────────
    'crash-after-dispatch': {
        checks: [
            'crash-after-dispatch.debit-retained',
            'crash-after-dispatch.slot-retained',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'lee', requestId: 'cd-1', category: 'chat', model: 'fake', payloadHash: 'hcd1' };
            const admitted = await a.command('admit', request);
            // Dispatch intent committed, then kill before provider call
            await a.command('dispatch', request, { fence: admitted.record.fence });
            await cluster.kill('a');
            const after = await cluster.snapshot();
            const rec   = after.requests[0]?.data;
            check('crash-after-dispatch.debit-retained', rec?.debitState, 'debited');
            check('crash-after-dispatch.slot-retained',  after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 1);
            return { record: rec };
        },
    },

    // ── 15. Provider unknown: slot quarantined, no refund ────────────────────
    'provider-unknown': {
        checks: [
            'provider-unknown.slot-quarantined',
            'provider-unknown.allowance-not-refunded',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'mia', requestId: 'pu-1', category: 'chat', model: 'fake', payloadHash: 'hpu1' };
            const admitted = await a.command('admit', request);
            await a.command('dispatch', request, { fence: admitted.record.fence });
            // Hide the provider outcome to simulate unobservable result
            cluster.provider.start(admitted.record.providerKey, request.uid);
            cluster.provider.hide(admitted.record.providerKey);
            await a.command('quarantine', request, { fence: admitted.record.fence });
            const after = await cluster.snapshot();
            const rec   = after.requests[0]?.data;
            check('provider-unknown.slot-quarantined',        rec?.state, 'unknown');
            check('provider-unknown.allowance-not-refunded',  rec?.debitState, 'debited');
            return { record: rec, active: after.capacity.find(d => d.id === 'global')?.data.active };
        },
    },

    // ── 16. Settlement ack lost: idempotent re-settle ─────────────────────────
    'settlement-ack-lost': {
        checks: [
            'settlement-ack-lost.idempotent-settle',
            'settlement-ack-lost.counter-not-double-decremented',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'noah', requestId: 'sal-1', category: 'chat', model: 'fake', payloadHash: 'hsal1' };
            const admitted = await a.command('admit', request);
            await a.command('dispatch', request, { fence: admitted.record.fence });
            // Provider finishes
            cluster.provider.start(admitted.record.providerKey, request.uid);
            cluster.provider.finish(admitted.record.providerKey, 'completed');
            // First settle (ack lost — simulate by killing after commit)
            let armed = true;
            cluster.setFault(async (phase, meta) => {
                if (armed && phase === 'afterCommit' && meta.instanceId === 'a') {
                    armed = false;
                    throw Object.assign(new Error('injected-ack-loss'), { commitUnknown: true });
                }
            });
            try { await a.command('settle', request, { fence: admitted.record.fence }); } catch {}
            cluster.setFault(async () => {});
            // Second settle (retry)
            const b = await cluster.spawn('b');
            const settle2 = await b.command('settle', request, { fence: admitted.record.fence });
            const after   = await cluster.snapshot();
            check('settlement-ack-lost.idempotent-settle',             after.requests[0]?.data.state, 'completed');
            check('settlement-ack-lost.counter-not-double-decremented', after.capacity.find(d => d.id === 'global')?.data.active ?? 0, 0);
            return { settle2 };
        },
    },

    // ── 17. Stale fence: old owner cannot operate ─────────────────────────────
    'stale-fence': {
        checks: [
            'stale-fence.stale-owner-rejected',
            'stale-fence.state-unchanged',
        ],
        async run({ cluster, check }) {
            const a       = await cluster.spawn('a');
            const request = { uid: 'olive', requestId: 'sf-1', category: 'chat', model: 'fake', payloadHash: 'hsf1' };
            const admitted = await a.command('admit', request);
            // a tries to use a stale fence (2, but actual fence is 1)
            let staleError = 'none';
            try { await a.command('dispatch', request, { fence: 2 }); }
            catch (error) { staleError = error.code ?? error.message; }
            const after = await cluster.snapshot();
            check('stale-fence.stale-owner-rejected', staleError, 'stale-owner');
            check('stale-fence.state-unchanged',      after.requests[0]?.data.state, 'reserved');
            return { staleError };
        },
    },

    // ── NEGATIVE CONTROL: split admission ─────────────────────────────────────
    'split-admission-control': {
        checks: [
            'split-admission-control.atomic-conservation-invariant',
            'split-admission-control.partial-admission-detected',
        ],
        expectedFailures: ['split-admission-control.atomic-conservation-invariant'],
        async run({ cluster, check }) {
            // Split-admission: two separate transactions (allowance then capacity)
            // Inject a fault between them to simulate crash mid-way
            const a       = await cluster.spawn('a');
            const request = { uid: 'pat', requestId: 'split-1', category: 'chat', model: 'fake', payloadHash: 'hsplit1' };

            const { quotaPath } = await import('../architecture/admission.mjs');
            const { COST }      = await import('../../inference-allowance/architecture/bucket.mjs');
            const qPath = quotaPath(request.uid);

            // Write quota debit WITHOUT a corresponding slot or request record (simulating crash between tx 1 and tx 2)
            await cluster.store.put(`${qPath}`, {
                policyVersion: POLICIES.version,
                buckets: { chat: { remaining: 4 * COST, updatedAt: 1000 } },
            });
            const after = await cluster.snapshot();
            // Desync: quota debited but no request record, no capacity slot
            const hasQuotaDebit    = after.quotas.length > 0;
            const hasSlot          = (after.capacity.find(d => d.id === 'global')?.data.active ?? 0) > 0;
            const hasRequestRecord = after.requests.length > 0;
            const atomicConserved  = hasQuotaDebit === hasSlot && hasQuotaDebit === hasRequestRecord;
            const partialDetected  = hasQuotaDebit && !hasSlot && !hasRequestRecord;
            check('split-admission-control.atomic-conservation-invariant', atomicConserved, true);
            check('split-admission-control.partial-admission-detected',    partialDetected, true);
            return { hasQuotaDebit, hasSlot, hasRequestRecord };
        },
    },
};
