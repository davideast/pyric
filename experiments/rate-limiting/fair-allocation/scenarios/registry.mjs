import {
    LIMITS,
    QUEUE_LIMITS,
    POLICIES,
    LOW_ALLOWANCE_POLICIES,
    VARIANTS,
    buildNoisyUserSchedule,
    buildBalancedBacklogSchedule,
    buildDurationMixSchedule,
} from '../fixtures/workloads.mjs';
import { createFairAllocationCluster } from '../adapters/pyric.mjs';
import { summarizeVariantOutcomes } from '../analysis/metrics.mjs';

/**
 * Helper to execute an offer schedule through a specific variant (`immediate`, `fifo`, `round-robin`)
 * on an isolated cluster and return full per-request records + metrics summary.
 */
async function runScheduleOnVariant(variant, offers, {
    caseId,
    limits = LIMITS,
    queueLimits = QUEUE_LIMITS,
    policies = POLICIES,
    backloggedUids = ['alice', 'bob', 'carol'],
    quietUids = [],
} = {}) {
    const cluster = await createFairAllocationCluster({
        caseId: `${caseId}-${variant}`,
        limits,
        queueLimits,
        policies,
    });

    const recordsByKey = new Map();

    // Group offers by plannedAtMs
    const steps = [...new Set(offers.map(o => o.plannedAtMs))].sort((a, b) => a - b);

    for (const stepTs of steps) {
        cluster.setTime(stepTs);
        const stepSettled = await cluster.settleDueJobs('disp-1');
        for (const s of stepSettled) {
            const key = `${s.uid}:${s.requestId}`;
            const rec = recordsByKey.get(key);
            if (rec) {
                rec.terminalState = s.state;
                rec.completedAt = cluster.now();
                rec.endToEndMs = cluster.now() - rec.plannedAtMs;
            }
        }

        const batch = offers.filter(o => o.plannedAtMs === stepTs);
        for (const offer of batch) {
            const key = `${offer.uid}:${offer.requestId}`;
            if (variant === 'immediate') {
                const res = await cluster.admitImmediate(offer, 'gw-1');
                recordsByKey.set(key, {
                    ...offer,
                    variant,
                    queueAdmitted:     false,
                    executionAdmitted: res.status === 'execution-admitted',
                    queueWaitMs:       res.status === 'execution-admitted' ? 0 : null,
                    admittedAt:        res.status === 'execution-admitted' ? stepTs : null,
                    terminalState:     res.status === 'execution-admitted' ? 'running' : res.status,
                });
            } else {
                const enq = await cluster.enqueue(offer, 'gw-1');
                recordsByKey.set(key, {
                    ...offer,
                    variant,
                    queueAdmitted:     enq.status === 'queue-admitted',
                    executionAdmitted: false,
                    queueWaitMs:       null,
                    admittedAt:        null,
                    terminalState:     enq.status === 'queue-admitted' ? 'queued' : enq.status,
                });
            }
        }

        // For queued variants, drain available execution capacity at this timestamp
        if (variant !== 'immediate') {
            while (true) {
                const sel = await cluster.selectNext(variant, 'disp-1');
                if (sel.status === 'execution-admitted') {
                    const key = `${sel.record.uid}:${sel.record.requestId}`;
                    const rec = recordsByKey.get(key);
                    if (rec) {
                        rec.executionAdmitted = true;
                        rec.admittedAt = sel.record.admittedAt;
                        rec.queueWaitMs = sel.record.queueWaitMs;
                        rec.terminalState = 'running';
                    }
                } else if (sel.status === 'quota-denied') {
                    const key = `${sel.record.uid}:${sel.record.requestId}`;
                    const rec = recordsByKey.get(key);
                    if (rec) rec.terminalState = 'quota-denied';
                } else {
                    break;
                }
            }
        }
    }

    // Drain remaining queued & running work across bounded horizon steps
    for (let drainStep = 0; drainStep < 30; drainStep++) {
        cluster.advance(200);
        const settled = await cluster.settleDueJobs('disp-1');
        for (const s of settled) {
            const key = `${s.uid}:${s.requestId}`;
            const rec = recordsByKey.get(key);
            if (rec) {
                rec.terminalState = s.state;
                rec.completedAt = cluster.now();
                rec.endToEndMs = cluster.now() - rec.plannedAtMs;
            }
        }
        if (variant !== 'immediate') {
            while (true) {
                const sel = await cluster.selectNext(variant, 'disp-1');
                if (sel.status === 'execution-admitted') {
                    const key = `${sel.record.uid}:${sel.record.requestId}`;
                    const rec = recordsByKey.get(key);
                    if (rec) {
                        rec.executionAdmitted = true;
                        rec.admittedAt = sel.record.admittedAt;
                        rec.queueWaitMs = sel.record.queueWaitMs;
                        rec.terminalState = 'running';
                    }
                } else if (sel.status === 'quota-denied') {
                    const key = `${sel.record.uid}:${sel.record.requestId}`;
                    const rec = recordsByKey.get(key);
                    if (rec) rec.terminalState = 'quota-denied';
                } else {
                    break;
                }
            }
        }
    }

    // Final settle pass
    cluster.advance(2_000);
    const finalSettled = await cluster.settleDueJobs('disp-1');
    for (const s of finalSettled) {
        const key = `${s.uid}:${s.requestId}`;
        const rec = recordsByKey.get(key);
        if (rec) {
            rec.terminalState = s.state;
            rec.completedAt = cluster.now();
            rec.endToEndMs = cluster.now() - rec.plannedAtMs;
        }
    }

    const records = [...recordsByKey.values()];
    const snap = await cluster.snapshot();
    const summary = summarizeVariantOutcomes(records, { backloggedUids, quietUids });

    return { variant, records, summary, snapshot: snap };
}

export const scenarios = {
    // ── 1. Balanced backlogged users ─────────────────────────────────────────
    'balanced-backlogged-users': {
        checks: [
            'balanced-backlogged-users.safety-bounds-respected',
            'balanced-backlogged-users.round-robin-jains-index-1',
            'balanced-backlogged-users.queued-completes-more-than-immediate',
        ],
        async run({ check }) {
            const { offers } = buildBalancedBacklogSchedule({ perUserCount: 5 });
            const runs = {};
            for (const variant of VARIANTS) {
                runs[variant] = await runScheduleOnVariant(variant, offers, {
                    caseId: 'balanced-backlogged-users',
                    backloggedUids: ['alice', 'bob', 'carol'],
                });
            }

            const boundsOk = VARIANTS.every(v =>
                runs[v].snapshot.oracle.peak <= LIMITS.global
                && runs[v].snapshot.oracle.peakPerUser <= LIMITS.perUser,
            );
            const rrJain = runs['round-robin'].summary.fairness.index;
            const rrCompleted = Object.values(runs['round-robin'].summary.users).reduce((a, u) => a + u.completed, 0);
            const immCompleted = Object.values(runs['immediate'].summary.users).reduce((a, u) => a + u.completed, 0);

            check('balanced-backlogged-users.safety-bounds-respected', boundsOk, true);
            check('balanced-backlogged-users.round-robin-jains-index-1', rrJain, 1);
            check('balanced-backlogged-users.queued-completes-more-than-immediate', rrCompleted > immCompleted, true);

            return Object.fromEntries(VARIANTS.map(v => [v, runs[v].summary]));
        },
    },

    // ── 2. One noisy user, two quiet users ───────────────────────────────────
    'one-noisy-two-quiet-users': {
        checks: [
            'one-noisy-two-quiet-users.safety-bounds-respected',
            'one-noisy-two-quiet-users.round-robin-protects-quiet-users',
            'one-noisy-two-quiet-users.round-robin-lower-quiet-wait-than-fifo',
        ],
        async run({ check }) {
            const { offers } = buildNoisyUserSchedule({ steps: 4 });
            const runs = {};
            for (const variant of VARIANTS) {
                runs[variant] = await runScheduleOnVariant(variant, offers, {
                    caseId: 'one-noisy-two-quiet-users',
                    backloggedUids: ['alice'],
                    quietUids: ['bob', 'carol'],
                });
            }

            const boundsOk = VARIANTS.every(v =>
                runs[v].snapshot.oracle.peak <= LIMITS.global
                && runs[v].snapshot.oracle.peakPerUser <= LIMITS.perUser,
            );
            const bobRR = runs['round-robin'].summary.quietCohort.bob;
            const carolRR = runs['round-robin'].summary.quietCohort.carol;
            const quietFulfilled = bobRR.fulfillmentRate === 1 && carolRR.fulfillmentRate === 1;

            const rrQuietMaxWait = Math.max(bobRR.queueWaitMs.max ?? 0, carolRR.queueWaitMs.max ?? 0);
            const fifoQuietMaxWait = Math.max(
                runs['fifo'].summary.quietCohort.bob.queueWaitMs.max ?? 0,
                runs['fifo'].summary.quietCohort.carol.queueWaitMs.max ?? 0,
            );

            check('one-noisy-two-quiet-users.safety-bounds-respected', boundsOk, true);
            check('one-noisy-two-quiet-users.round-robin-protects-quiet-users', quietFulfilled, true);
            check('one-noisy-two-quiet-users.round-robin-lower-quiet-wait-than-fifo', rrQuietMaxWait <= fifoQuietMaxWait, true);

            return Object.fromEntries(VARIANTS.map(v => [v, runs[v].summary]));
        },
    },

    // ── 3. Short and long operations ─────────────────────────────────────────
    'short-and-long-operations': {
        checks: [
            'short-and-long-operations.safety-bounds-respected',
            'short-and-long-operations.all-queued-jobs-complete',
        ],
        async run({ check }) {
            const { offers } = buildDurationMixSchedule({ seed: 42, count: 12 });
            const runs = {};
            for (const variant of VARIANTS) {
                runs[variant] = await runScheduleOnVariant(variant, offers, {
                    caseId: 'short-and-long-operations',
                });
            }

            const boundsOk = VARIANTS.every(v =>
                runs[v].snapshot.oracle.peak <= LIMITS.global
                && runs[v].snapshot.oracle.peakPerUser <= LIMITS.perUser,
            );
            const rrCompleted = Object.values(runs['round-robin'].summary.users).reduce((a, u) => a + u.completed, 0);

            check('short-and-long-operations.safety-bounds-respected', boundsOk, true);
            check('short-and-long-operations.all-queued-jobs-complete', rrCompleted, 12);

            return Object.fromEntries(VARIANTS.map(v => [v, runs[v].summary]));
        },
    },

    // ── 4. Distinct-user burst ───────────────────────────────────────────────
    'distinct-user-burst': {
        checks: [
            'distinct-user-burst.global-cap-enforced',
            'distinct-user-burst.immediate-admits-exactly-3',
            'distinct-user-burst.queued-completes-all-12',
        ],
        async run({ check }) {
            const offers = Array.from({ length: 12 }, (_, i) => ({
                index: i,
                uid: `burst-user-${i}`,
                cohort: 'burst',
                requestId: `burst-req-${i}`,
                category: 'chat',
                model: 'fake',
                payloadHash: `ph-burst-${i}`,
                plannedAtMs: 1_000,
                durationMs: 200,
            }));

            const imm = await runScheduleOnVariant('immediate', offers, { caseId: 'distinct-user-burst' });
            const rr = await runScheduleOnVariant('round-robin', offers, { caseId: 'distinct-user-burst' });

            const immCompleted = Object.values(imm.summary.users).reduce((a, u) => a + u.completed, 0);
            const rrCompleted = Object.values(rr.summary.users).reduce((a, u) => a + u.completed, 0);

            check('distinct-user-burst.global-cap-enforced', imm.snapshot.oracle.peak <= LIMITS.global && rr.snapshot.oracle.peak <= LIMITS.global, true);
            check('distinct-user-burst.immediate-admits-exactly-3', immCompleted, 3);
            check('distinct-user-burst.queued-completes-all-12', rrCompleted, 12);

            return { immediate: imm.summary, roundRobin: rr.summary };
        },
    },

    // ── 5. Duplicate offer storm ─────────────────────────────────────────────
    'duplicate-offer-storm': {
        checks: [
            'duplicate-offer-storm.single-enqueue-slot',
            'duplicate-offer-storm.payload-mismatch-rejected',
            'duplicate-offer-storm.single-provider-dispatch',
        ],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({ caseId: 'duplicate-offer-storm' });
            const req = { uid: 'alice', requestId: 'dup-1', category: 'chat', model: 'fake', payloadHash: 'hash-a', durationMs: 200 };

            const e1 = await cluster.enqueue(req, 'gw-1');
            const e2 = await cluster.enqueue(req, 'gw-2');

            let mismatchCode = 'none';
            try {
                await cluster.enqueue({ ...req, payloadHash: 'hash-different' }, 'gw-3');
            } catch (err) {
                mismatchCode = err.code ?? err.message;
            }

            await cluster.selectNext('fifo', 'disp-1');
            const snap = await cluster.snapshot();

            check('duplicate-offer-storm.single-enqueue-slot', e1.status === 'queue-admitted' && e2.status === 'duplicate', true);
            check('duplicate-offer-storm.payload-mismatch-rejected', mismatchCode, 'payload_mismatch');
            check('duplicate-offer-storm.single-provider-dispatch', snap.oracle.startAttempts, 1);

            return { e1: e1.status, e2: e2.status, mismatchCode };
        },
    },

    // ── 6. Queue overload ────────────────────────────────────────────────────
    'queue-overload': {
        checks: [
            'queue-overload.user-queue-limit-enforced',
            'queue-overload.global-queue-limit-enforced',
        ],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({ caseId: 'queue-overload' });

            // Enqueue 9 items for alice (per-user limit = 8)
            const aliceResults = [];
            for (let i = 0; i < 9; i++) {
                const res = await cluster.enqueue({
                    uid: 'alice',
                    requestId: `over-alice-${i}`,
                    category: 'chat',
                    model: 'fake',
                    payloadHash: `ph-oa-${i}`,
                }, 'gw-1');
                aliceResults.push(res);
            }

            // Fill remaining global queue capacity across bob (8), carol (8) -> total 8 + 8 + 8 = 24
            for (const uid of ['bob', 'carol']) {
                for (let i = 0; i < 8; i++) {
                    await cluster.enqueue({
                        uid,
                        requestId: `over-${uid}-${i}`,
                        category: 'chat',
                        model: 'fake',
                        payloadHash: `ph-o-${uid}-${i}`,
                    }, 'gw-1');
                }
            }

            // 25th global item from dave must fail with global-queue-full
            const daveRes = await cluster.enqueue({
                uid: 'dave',
                requestId: 'over-dave-0',
                category: 'chat',
                model: 'fake',
                payloadHash: 'ph-od-0',
            }, 'gw-1');

            check('queue-overload.user-queue-limit-enforced', aliceResults[8].reason, 'user-queue-full');
            check('queue-overload.global-queue-limit-enforced', daveRes.reason, 'global-queue-full');

            return { ninthAlice: aliceResults[8], twentyFifthGlobal: daveRes };
        },
    },

    // ── 7. Queue cancellation and expiry ─────────────────────────────────────
    'queue-cancellation-and-expiry': {
        checks: [
            'queue-cancellation-and-expiry.cancelled-never-dispatches',
            'queue-cancellation-and-expiry.expired-never-dispatches',
            'queue-cancellation-and-expiry.dispatched-rejects-cancel',
        ],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({ caseId: 'queue-cancellation-and-expiry' });

            const reqCancel = { uid: 'alice', requestId: 'qce-cancel', category: 'chat', model: 'fake', payloadHash: 'ph-c' };
            const reqLive = { uid: 'bob', requestId: 'qce-live', category: 'chat', model: 'fake', payloadHash: 'ph-l' };
            const reqExpire = { uid: 'carol', requestId: 'qce-expire', category: 'chat', model: 'fake', payloadHash: 'ph-e' };

            await cluster.enqueue(reqCancel, 'gw-1');
            await cluster.enqueue(reqLive, 'gw-1');
            await cluster.enqueue(reqExpire, 'gw-1');

            const cancelled = await cluster.cancelQueued(reqCancel, 'gw-1');

            // Select bob's live job first while TTL is still valid
            const selected = await cluster.selectNext('round-robin', 'disp-1');
            const lateCancel = await cluster.cancelQueued(reqLive, 'gw-1');

            // Advance past queue TTL (30_000 ms) so carol's queued entry expires
            cluster.advance(31_000);
            const expired = await cluster.expireQueued(reqExpire, 'gw-1');

            check('queue-cancellation-and-expiry.cancelled-never-dispatches', cancelled.status, 'cancelled');
            check('queue-cancellation-and-expiry.expired-never-dispatches', expired.status, 'expired');
            check('queue-cancellation-and-expiry.dispatched-rejects-cancel', lateCancel.status, 'already-dispatched');

            return { cancelled: cancelled.status, expired: expired.status, lateCancel: lateCancel.status, selected: selected.record?.requestId };
        },
    },

    // ── 8. Unknown running work retains slot ─────────────────────────────────
    'unknown-running-work': {
        checks: [
            'unknown-running-work.slot-retained-on-unknown',
            'unknown-running-work.remaining-capacity-bounded',
        ],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({ caseId: 'unknown-running-work' });
            const reqUnknown = { uid: 'alice', requestId: 'unk-1', category: 'chat', model: 'fake', payloadHash: 'ph-u1' };
            await cluster.enqueue(reqUnknown, 'gw-1');
            const sel = await cluster.selectNext('fifo', 'disp-1');

            // Hide provider job to simulate unobservable remote state & quarantine
            cluster.provider.hide(sel.record.providerKey);
            await cluster.quarantineJob(reqUnknown, sel.record.fence, 'disp-1');

            const snap = await cluster.snapshot();
            const globalActive = snap.capacity.find(d => d.id === 'global')?.data.active ?? 0;

            check('unknown-running-work.slot-retained-on-unknown', globalActive, 1);
            check('unknown-running-work.remaining-capacity-bounded', LIMITS.global - globalActive, 2);

            return { globalActive };
        },
    },

    // ── 9. Selector restart and competing selectors ──────────────────────────
    'selector-restart-and-competing-selectors': {
        checks: [
            'selector-restart-and-competing-selectors.no-double-dispatch',
            'selector-restart-and-competing-selectors.cursor-rotates-across-workers',
        ],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({ caseId: 'selector-restart-and-competing-selectors' });

            for (const uid of ['alice', 'bob', 'carol']) {
                await cluster.enqueue({ uid, requestId: `race-${uid}-1`, category: 'chat', model: 'fake', payloadHash: `ph-r-${uid}` }, 'gw-1');
            }

            // Two dispatchers race on selection
            const [s1, s2] = await Promise.all([
                cluster.selectNext('round-robin', 'disp-1'),
                cluster.selectNext('round-robin', 'disp-2'),
            ]);

            // Replacement dispatcher disp-3 takes over for the 3rd item
            const s3 = await cluster.selectNext('round-robin', 'disp-3');

            const selectedUids = [s1, s2, s3]
                .filter(s => s.status === 'execution-admitted')
                .map(s => s.record.uid)
                .sort();

            const snap = await cluster.snapshot();

            check('selector-restart-and-competing-selectors.no-double-dispatch', snap.oracle.startAttempts, 3);
            check('selector-restart-and-competing-selectors.cursor-rotates-across-workers', selectedUids, ['alice', 'bob', 'carol']);

            return { selectedUids, startAttempts: snap.oracle.startAttempts };
        },
    },

    // ── 10. Allowance exhaustion interaction ─────────────────────────────────
    'allowance-exhaustion-interaction': {
        checks: [
            'allowance-exhaustion-interaction.denied-removed-from-queue',
            'allowance-exhaustion-interaction.eligible-user-proceeds',
        ],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({
                caseId: 'allowance-exhaustion-interaction',
                policies: LOW_ALLOWANCE_POLICIES,
            });

            // Alice enqueues 3 requests (her low allowance covers only 2)
            for (let i = 0; i < 3; i++) {
                await cluster.enqueue({ uid: 'alice', requestId: `low-alice-${i}`, category: 'chat', model: 'fake', payloadHash: `ph-la-${i}` }, 'gw-1');
            }
            // Bob enqueues 1 request (his allowance is fresh)
            await cluster.enqueue({ uid: 'bob', requestId: 'low-bob-0', category: 'chat', model: 'fake', payloadHash: 'ph-lb-0' }, 'gw-1');

            const r1 = await cluster.selectNext('fifo', 'disp-1'); // alice #0 admitted
            const r2 = await cluster.selectNext('fifo', 'disp-1'); // alice #1 admitted
            // Complete alice's first job to free an execution slot
            cluster.advance(250);
            await cluster.settleDueJobs('disp-1');

            const r3 = await cluster.selectNext('fifo', 'disp-1'); // alice #2 quota-denied!
            const r4 = await cluster.selectNext('fifo', 'disp-1'); // bob #0 admitted!

            check('allowance-exhaustion-interaction.denied-removed-from-queue', r3.status, 'quota-denied');
            check('allowance-exhaustion-interaction.eligible-user-proceeds', r4.status === 'execution-admitted' && r4.record.uid === 'bob', true);

            return { r1: r1.status, r2: r2.status, r3: r3.status, r4: r4.status };
        },
    },

    // ── 11. NEGATIVE CONTROL: Unbounded per-user cap ─────────────────────────
    'unbounded-no-cap-control': {
        checks: [
            'unbounded-no-cap-control.per-user-cap-preserved',
            'unbounded-no-cap-control.monopolization-detected',
        ],
        expectedFailures: ['unbounded-no-cap-control.per-user-cap-preserved'],
        async run({ check }) {
            const cluster = await createFairAllocationCluster({
                caseId: 'unbounded-no-cap-control',
                limits: { global: 3, perUser: 99, leaseMs: 10_000 },
            });

            // Alice sends 3 simultaneous requests and monopolizes all 3 global slots
            for (let i = 0; i < 3; i++) {
                await cluster.admitImmediate({
                    uid: 'alice',
                    requestId: `mono-${i}`,
                    category: 'chat',
                    model: 'fake',
                    payloadHash: `ph-m-${i}`,
                }, 'gw-1');
            }

            const snap = await cluster.snapshot();
            // Raw safety check against standard perUser limit (2) fails as expected (peakPerUser = 3)
            check('unbounded-no-cap-control.per-user-cap-preserved', snap.oracle.peakPerUser <= LIMITS.perUser, true);
            check('unbounded-no-cap-control.monopolization-detected', snap.oracle.peakPerUser > LIMITS.perUser, true);

            return { peakPerUser: snap.oracle.peakPerUser, standardLimit: LIMITS.perUser };
        },
    },
};
