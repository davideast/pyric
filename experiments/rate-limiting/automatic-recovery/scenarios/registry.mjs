import { LIMITS } from '../fixtures/contracts.mjs';

const activeGlobal = snap => snap.capacity.find(d => d.id === 'global')?.data.active ?? 0;

export const scenarios = {
    // ── 1. Death after reservation (pre-dispatch) ───────────────────────────
    'death-after-reservation': {
        checks: [
            'death-after-reservation.no-second-debit',
            'death-after-reservation.slot-released',
            'death-after-reservation.state-refunded',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'alice', requestId: 'dar-1', category: 'chat', model: 'fake', payloadHash: 'hdar1' };
            await gw.command('admit', req);
            await cluster.kill('gw-a');

            // Advance past lease expiry (leaseMs = 10_000)
            cluster.advance(11_000);

            const rec = await cluster.spawnRecoveryWorker('rec-1');
            const sweep = await rec.command('sweep');
            const snap = await cluster.snapshot();
            const record = snap.requests[0]?.data;

            check('death-after-reservation.no-second-debit', snap.quotas.length, 1);
            check('death-after-reservation.slot-released', activeGlobal(snap), 0);
            check('death-after-reservation.state-refunded', record?.state, 'refunded');
            return { sweep, record };
        },
    },

    // ── 2. Death after dispatch intent before observed start ────────────────
    'death-after-intent-before-start': {
        checks: [
            'death-after-intent-before-start.no-blind-resend',
            'death-after-intent-before-start.slot-retained',
            'death-after-intent-before-start.explicit-quarantine',
        ],
        contractLimited: true,
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'alice', requestId: 'daibs-1', category: 'chat', model: 'fake', payloadHash: 'hdaibs1' };
            const admitted = await gw.command('admit', req);
            await gw.command('dispatch', req, { fence: admitted.record.fence });
            // Crash before calling provider.start()
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            const sweep = await rec.command('sweep');
            const snap = await cluster.snapshot();
            const record = snap.requests[0]?.data;

            check('death-after-intent-before-start.no-blind-resend', cluster.provider.snapshot().startAttempts, 0);
            check('death-after-intent-before-start.slot-retained', activeGlobal(snap), 1);
            check('death-after-intent-before-start.explicit-quarantine', record?.quarantineReason, 'provider-unobservable');
            return { sweep, record };
        },
    },

    // ── 3. Death while provider runs ────────────────────────────────────────
    'death-while-provider-runs': {
        checks: [
            'death-while-provider-runs.retained-while-running',
            'death-while-provider-runs.released-after-completion',
            'death-while-provider-runs.state-completed',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'alice', requestId: 'dwpr-1', category: 'chat', model: 'fake', payloadHash: 'hdwpr1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            await cluster.kill('gw-a');

            // First sweep while provider is still running
            cluster.advance(11_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            await rec.command('sweep');
            const midSnap = await cluster.snapshot();
            check('death-while-provider-runs.retained-while-running', activeGlobal(midSnap), 1);

            // Provider finishes; advance past recovery worker lease so next sweep claims & settles
            cluster.provider.finish(dispatching.providerKey, 'completed');
            cluster.advance(11_000);
            await rec.command('sweep');
            const finalSnap = await cluster.snapshot();

            check('death-while-provider-runs.released-after-completion', activeGlobal(finalSnap), 0);
            check('death-while-provider-runs.state-completed', finalSnap.requests[0]?.data.state, 'completed');
            return { finalState: finalSnap.requests[0]?.data };
        },
    },

    // ── 4. Provider completes while gateway is dead ─────────────────────────
    'provider-completes-while-gateway-dead': {
        checks: [
            'provider-completes-while-gateway-dead.single-settlement',
            'provider-completes-while-gateway-dead.slot-released',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'bob', requestId: 'pcwgd-1', category: 'chat', model: 'fake', payloadHash: 'hpcwgd1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            await cluster.kill('gw-a');

            // Provider completes while gateway is dead
            cluster.provider.finish(dispatching.providerKey, 'completed');
            cluster.advance(11_000);

            const rec = await cluster.spawnRecoveryWorker('rec-1');
            const sweep = await rec.command('sweep');
            const snap = await cluster.snapshot();

            check('provider-completes-while-gateway-dead.single-settlement', snap.requests[0]?.data.state, 'completed');
            check('provider-completes-while-gateway-dead.slot-released', activeGlobal(snap), 0);
            return { sweep };
        },
    },

    // ── 5. Two recovery workers claim together ──────────────────────────────
    'two-recovery-workers-claim-race': {
        checks: [
            'two-recovery-workers-claim-race.one-winner',
            'two-recovery-workers-claim-race.one-lease-owned-loser',
            'two-recovery-workers-claim-race.single-fence-increment',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'carol', requestId: 'race-1', category: 'chat', model: 'fake', payloadHash: 'hrace1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.finish(dispatching.providerKey, 'completed');
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec1 = await cluster.spawnRecoveryWorker('rec-1');
            const rec2 = await cluster.spawnRecoveryWorker('rec-2');

            const results = await Promise.all([
                rec1.command('claim', req),
                rec2.command('claim', req),
            ]);
            const winners = results.filter(r => r.status === 'claimed');
            const losers  = results.filter(r => r.status === 'lease-owned');

            check('two-recovery-workers-claim-race.one-winner', winners.length, 1);
            check('two-recovery-workers-claim-race.one-lease-owned-loser', losers.length, 1);
            check('two-recovery-workers-claim-race.single-fence-increment', winners[0]?.record.fence, 2);
            return { winners: winners.length, losers: losers.length };
        },
    },

    // ── 6. Recovery worker dies after claim ─────────────────────────────────
    'recovery-worker-dies-after-claim': {
        checks: [
            'recovery-worker-dies-after-claim.no-duplicate-provider-call',
            'recovery-worker-dies-after-claim.second-worker-completes',
            'recovery-worker-dies-after-claim.fence-reaches-3',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'dave', requestId: 'rwdac-1', category: 'chat', model: 'fake', payloadHash: 'hrwdac1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.finish(dispatching.providerKey, 'completed');
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec1 = await cluster.spawnRecoveryWorker('rec-1');
            const claim1 = await rec1.command('claim', req);
            // rec-1 dies right after claiming (fence = 2)
            await cluster.kill('rec-1');

            // Advance past rec-1's lease so rec-2 can claim at fence = 3
            cluster.advance(11_000);
            const rec2 = await cluster.spawnRecoveryWorker('rec-2');
            const sweep = await rec2.command('sweep');
            const snap = await cluster.snapshot();
            const record = snap.requests[0]?.data;

            check('recovery-worker-dies-after-claim.no-duplicate-provider-call', cluster.provider.snapshot().startAttempts, 1);
            check('recovery-worker-dies-after-claim.second-worker-completes', record?.state, 'completed');
            check('recovery-worker-dies-after-claim.fence-reaches-3', record?.fence, 3);
            return { claim1, sweep, record };
        },
    },

    // ── 7. Stale observation arrives after takeover ─────────────────────────
    'stale-observation-after-takeover': {
        checks: [
            'stale-observation-after-takeover.stale-worker-rejected',
            'stale-observation-after-takeover.slot-released-once',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'eve', requestId: 'soat-1', category: 'chat', model: 'fake', payloadHash: 'hsoat1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec1 = await cluster.spawnRecoveryWorker('rec-1');
            const claim1 = await rec1.command('claim', req); // fence = 2

            // rec-1 stalls while observing 'running'; lease expires and rec-2 takes over (fence = 3)
            cluster.advance(11_000);
            const rec2 = await cluster.spawnRecoveryWorker('rec-2');
            const claim2 = await rec2.command('claim', req); // fence = 3

            // Now rec-1 tries to apply its stale 'running' observation with fence = 2
            let staleError = 'none';
            try {
                await rec1.command('reconcile', { ...req, providerKey: dispatching.providerKey }, {
                    fence: claim1.record.fence,
                    evidence: { key: dispatching.providerKey, state: 'running' },
                });
            } catch (error) {
                staleError = error.code ?? error.message;
            }

            // Current owner rec-2 finishes settlement cleanly
            cluster.provider.finish(dispatching.providerKey, 'completed');
            await rec2.command('reconcile', { ...req, providerKey: dispatching.providerKey }, {
                fence: claim2.record.fence,
                evidence: { key: dispatching.providerKey, state: 'completed' },
            });
            const snap = await cluster.snapshot();

            check('stale-observation-after-takeover.stale-worker-rejected', staleError, 'stale-owner');
            check('stale-observation-after-takeover.slot-released-once', activeGlobal(snap), 0);
            return { staleError };
        },
    },

    // ── 8. Settlement commits, response lost ────────────────────────────────
    'settlement-commits-response-lost': {
        checks: [
            'settlement-commits-response-lost.no-double-decrement',
            'settlement-commits-response-lost.terminal-recognized',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'frank', requestId: 'scrl-1', category: 'chat', model: 'fake', payloadHash: 'hscrl1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.finish(dispatching.providerKey, 'completed');
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec1 = await cluster.spawnRecoveryWorker('rec-1');
            const claim1 = await rec1.command('claim', req);

            // Drop acknowledgment on afterCommit of settlement
            let armed = true;
            cluster.setFault(async (phase) => {
                if (armed && phase === 'afterCommit') {
                    armed = false;
                    throw Object.assign(new Error('injected-ack-loss'), { commitUnknown: true });
                }
            });
            try {
                await rec1.command('reconcile', { ...req, providerKey: dispatching.providerKey }, { fence: claim1.record.fence });
            } catch {}
            cluster.setFault(async () => {});

            // Retry reconciliation recognizes saved terminal state without double decrement
            const retry = await rec1.command('reconcile', { ...req, providerKey: dispatching.providerKey }, { fence: claim1.record.fence });
            const snap = await cluster.snapshot();

            check('settlement-commits-response-lost.no-double-decrement', activeGlobal(snap), 0);
            check('settlement-commits-response-lost.terminal-recognized', retry.action, 'idempotent-terminal');
            return { retry };
        },
    },

    // ── 9. Stop acknowledged but not confirmed ──────────────────────────────
    'stop-acknowledged-not-confirmed': {
        checks: [
            'stop-acknowledged-not-confirmed.retained-while-stop-pending',
            'stop-acknowledged-not-confirmed.released-after-confirmed-cancel',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'grace', requestId: 'sanc-1', category: 'chat', model: 'fake', payloadHash: 'hsanc1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.requestStop(dispatching.providerKey);
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            await rec.command('sweep');
            const midSnap = await cluster.snapshot();
            check('stop-acknowledged-not-confirmed.retained-while-stop-pending', activeGlobal(midSnap), 1);

            cluster.provider.finish(dispatching.providerKey, 'cancelled');
            cluster.advance(11_000);
            await rec.command('sweep');
            const finalSnap = await cluster.snapshot();
            check('stop-acknowledged-not-confirmed.released-after-confirmed-cancel', activeGlobal(finalSnap), 0);
            return { finalState: finalSnap.requests[0]?.data };
        },
    },

    // ── 10. Provider status transiently unavailable ─────────────────────────
    'provider-status-transiently-unavailable': {
        checks: [
            'provider-status-transiently-unavailable.no-guessed-termination',
            'provider-status-transiently-unavailable.recovered-when-available',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'hank', requestId: 'pstu-1', category: 'chat', model: 'fake', payloadHash: 'hpstu1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.finish(dispatching.providerKey, 'completed');
            // Inject transient unavailability for the first observation
            cluster.provider.setUnavailable(dispatching.providerKey, 1);
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            await rec.command('sweep');
            const midSnap = await cluster.snapshot();
            check('provider-status-transiently-unavailable.no-guessed-termination', activeGlobal(midSnap), 1);

            // Second sweep after lease & backoff succeeds because provider is now available
            cluster.advance(11_000);
            await rec.command('sweep');
            const finalSnap = await cluster.snapshot();
            check('provider-status-transiently-unavailable.recovered-when-available', activeGlobal(finalSnap), 0);
            return { finalState: finalSnap.requests[0]?.data };
        },
    },

    // ── 11. Provider forever unobservable ───────────────────────────────────
    'provider-forever-unobservable': {
        checks: [
            'provider-forever-unobservable.slot-retained',
            'provider-forever-unobservable.explicit-quarantine-reason',
        ],
        contractLimited: true,
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            const req = { uid: 'iris', requestId: 'pfu-1', category: 'chat', model: 'fake', payloadHash: 'hpfu1' };
            const admitted = await gw.command('admit', req);
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.hide(dispatching.providerKey);
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            await rec.command('sweep');
            const snap = await cluster.snapshot();
            const record = snap.requests[0]?.data;

            check('provider-forever-unobservable.slot-retained', activeGlobal(snap), 1);
            check('provider-forever-unobservable.explicit-quarantine-reason', record?.quarantineReason, 'provider-unobservable');
            return { record };
        },
    },

    // ── 12. Reconciler backlog spans pages (anti-starvation) ────────────────
    'reconciler-backlog-spans-pages': {
        checks: [
            'reconciler-backlog-spans-pages.all-completed-jobs-released',
            'reconciler-backlog-spans-pages.stuck-job-quarantined',
        ],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            // Admit 3 requests across users (global limit = 3):
            // req-0 is unobservable (page 1 head-of-line blocker)
            // req-1 and req-2 are completed
            const items = [];
            for (let i = 0; i < 3; i++) {
                const req = { uid: `user-${i}`, requestId: `backlog-${i}`, category: 'chat', model: 'fake', payloadHash: `hb${i}` };
                const admitted = await gw.command('admit', req);
                const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
                await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
                items.push({ req, dispatching });
            }
            // Item 0 is forever unobservable; Items 1 and 2 completed
            cluster.provider.hide(items[0].dispatching.providerKey);
            cluster.provider.finish(items[1].dispatching.providerKey, 'completed');
            cluster.provider.finish(items[2].dispatching.providerKey, 'completed');
            await cluster.kill('gw-a');

            cluster.advance(11_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            const sweep = await rec.command('sweep');
            const snap = await cluster.snapshot();

            const completedCount = snap.requests.filter(r => r.data.state === 'completed').length;
            const quarantinedCount = snap.requests.filter(r => r.data.quarantineReason === 'provider-unobservable').length;

            check('reconciler-backlog-spans-pages.all-completed-jobs-released', completedCount, 2);
            check('reconciler-backlog-spans-pages.stuck-job-quarantined', quarantinedCount, 1);
            return { sweep, completedCount, quarantinedCount };
        },
    },

    // ── 13. Clock offsets and renew/takeover races ──────────────────────────
    'clock-offsets-and-renew-races': {
        checks: [
            'clock-offsets-and-renew-races.stale-heartbeat-rejected',
            'clock-offsets-and-renew-races.recovery-owner-settles',
        ],
        async run({ cluster, check }) {
            // Advance cluster clock to 11_000 so a -8_000 ms skewed gateway still has a positive clock (3_000 ms)
            cluster.advance(10_000);
            const gw = await cluster.spawnGateway('gw-skewed', { clockOffsetMs: -8_000 });
            const req = { uid: 'jan', requestId: 'clock-1', category: 'chat', model: 'fake', payloadHash: 'hclock1' };
            const admitted = await gw.command('admit', req); // gw clock = 3_000 -> leaseUntil = 13_000
            const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
            await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            cluster.provider.finish(dispatching.providerKey, 'completed');

            // Advance 5_000 ms: cluster clock = 16_000 (> leaseUntil 13_000), while gw clock = 8_000 (< leaseUntil 13_000)
            cluster.advance(5_000);
            const rec = await cluster.spawnRecoveryWorker('rec-1');
            const claim = await rec.command('claim', req); // fence = 2

            // Slow gateway (thinking its lease is still valid at gw clock 8_000 < 13_000) tries to renew heartbeat with fence = 1
            let renewError = 'none';
            try {
                await gw.command('heartbeat', req, { fence: admitted.record.fence });
            } catch (error) {
                renewError = error.code ?? error.message;
            }

            await rec.command('reconcile', { ...req, providerKey: dispatching.providerKey }, { fence: claim.record.fence });
            const snap = await cluster.snapshot();

            check('clock-offsets-and-renew-races.stale-heartbeat-rejected', renewError, 'stale-owner');
            check('clock-offsets-and-renew-races.recovery-owner-settles', activeGlobal(snap), 0);
            return { renewError };
        },
    },

    // ── 14. NEGATIVE CONTROL: Expiry-only release control ───────────────────
    'expiry-only-release-control': {
        checks: [
            'expiry-only-release-control.concurrency-bound-preserved',
            'expiry-only-release-control.over-admission-detected',
        ],
        expectedFailures: ['expiry-only-release-control.concurrency-bound-preserved'],
        async run({ cluster, check }) {
            const gw = await cluster.spawnGateway('gw-a');
            // Fill all 3 global slots with running provider jobs
            for (let i = 0; i < LIMITS.global; i++) {
                const req = { uid: `user-${i}`, requestId: `unsafe-${i}`, category: 'chat', model: 'fake', payloadHash: `hu${i}` };
                const admitted = await gw.command('admit', req);
                const dispatching = await gw.command('dispatch', req, { fence: admitted.record.fence });
                await gw.command('provider-start', { ...req, providerKey: dispatching.providerKey });
            }

            // Advance past lease expiry while all 3 remote provider jobs are STILL running
            cluster.advance(11_000);
            // Unsafe control releases slot on lease expiry without checking provider termination
            await gw.command('unsafe-expire', { uid: 'user-0', requestId: 'unsafe-0' });

            // A 4th request is now admitted and starts a 4th concurrent provider job!
            const req4 = { uid: 'overflow', requestId: 'unsafe-overflow', category: 'chat', model: 'fake', payloadHash: 'huov' };
            const admitted4 = await gw.command('admit', req4);
            const dispatching4 = await gw.command('dispatch', req4, { fence: admitted4.record.fence });
            await gw.command('provider-start', { ...req4, providerKey: dispatching4.providerKey });

            const oracle = cluster.provider.snapshot();
            // Raw safety assertion fails (peak = 4 > LIMITS.global = 3)
            check('expiry-only-release-control.concurrency-bound-preserved', oracle.peak <= LIMITS.global, true);
            check('expiry-only-release-control.over-admission-detected', oracle.peak > LIMITS.global, true);
            return { peak: oracle.peak, limit: LIMITS.global };
        },
    },
};
