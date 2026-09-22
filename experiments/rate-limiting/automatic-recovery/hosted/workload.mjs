// Hosted HTTP workload executing all 13 autonomous recovery scenarios against
// either local Pyric HTTP server (--local) or deployed Cloud Run + Native Firestore.

const activeGlobal = snap => snap.capacity.find(d => d.id === 'global')?.data.active ?? 0;

export async function runHostedWorkload({ measurementId, command, onCase = () => {} }) {
    const cases = [], assertions = [];
    let commands = 0;

    const send = async (caseId, body) => {
        commands++;
        return command(caseId, body);
    };

    const runCase = async (id, fn) => {
        const startedAt = new Date().toISOString();
        const caseAssertions = [];
        const check = (name, actual, expected) => {
            const passed = JSON.stringify(actual) === JSON.stringify(expected);
            const row = { caseId: id, name, passed, actual, expected };
            assertions.push(row);
            caseAssertions.push(row);
        };
        const out = await fn(check);
        const snapRes = await send(id, { operation: 'inspect' });
        const state = snapRes.body.output;
        const row = {
            id,
            status: 'completed',
            passed: caseAssertions.every(a => a.passed),
            assertions: caseAssertions,
            output: out,
            state,
            startedAt,
            endedAt: new Date().toISOString(),
        };
        cases.push(row);
        onCase({ id, passed: row.passed, assertions: caseAssertions.length });
        return row;
    };

    // 1. Death after reservation (pre-dispatch)
    await runCase('death-after-reservation', async check => {
        const req = { uid: 'alice', requestId: 'dar-1', category: 'chat', model: 'fake', payloadHash: 'hdar1' };
        await send('death-after-reservation', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        // Lease expires at 11_000; sweep runs at 12_000
        const sweep = await send('death-after-reservation', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap = (await send('death-after-reservation', { operation: 'inspect' })).body.output;
        const record = snap.requests[0]?.data;
        check('death-after-reservation.no-second-debit', snap.quotas.length, 1);
        check('death-after-reservation.slot-released', activeGlobal(snap), 0);
        check('death-after-reservation.state-refunded', record?.state, 'refunded');
        return sweep.body.output;
    });

    // 2. Death after intent before provider start
    await runCase('death-after-intent-before-start', async check => {
        const req = { uid: 'bob', requestId: 'daibs-1', category: 'chat', model: 'fake', payloadHash: 'hdaibs1' };
        const admitted = await send('death-after-intent-before-start', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('death-after-intent-before-start', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        // Gateway crashes before provider-start; recovery worker sweeps at 12_000
        const sweep = await send('death-after-intent-before-start', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap = (await send('death-after-intent-before-start', { operation: 'inspect' })).body.output;
        const record = snap.requests[0]?.data;
        check('death-after-intent-before-start.no-blind-resend', snap.provider.length, 0);
        check('death-after-intent-before-start.slot-retained', activeGlobal(snap), 1);
        check('death-after-intent-before-start.explicit-quarantine', Boolean(record?.quarantineReason), true);
        return sweep.body.output;
    });

    // 3. Death while provider runs
    await runCase('death-while-provider-runs', async check => {
        const req = { uid: 'carol', requestId: 'dwpr-1', category: 'chat', model: 'fake', payloadHash: 'hdwpr1' };
        const admitted = await send('death-while-provider-runs', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('death-while-provider-runs', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('death-while-provider-runs', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });

        // First sweep at 12_000: provider still running -> slot retained
        await send('death-while-provider-runs', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap1 = (await send('death-while-provider-runs', { operation: 'inspect' })).body.output;
        check('death-while-provider-runs.retained-while-running', activeGlobal(snap1), 1);

        // Provider completes, second sweep at 25_000 -> slot released
        await send('death-while-provider-runs', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 24_000 });
        await send('death-while-provider-runs', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 25_000 });
        const snap2 = (await send('death-while-provider-runs', { operation: 'inspect' })).body.output;
        check('death-while-provider-runs.released-after-completion', activeGlobal(snap2), 0);
        check('death-while-provider-runs.state-completed', snap2.requests[0]?.data?.state, 'completed');
        return { afterCompletionActive: activeGlobal(snap2) };
    });

    // 4. Provider completes while gateway dead
    await runCase('provider-completes-while-gateway-dead', async check => {
        const req = { uid: 'dave', requestId: 'pcwgd-1', category: 'chat', model: 'fake', payloadHash: 'hpcwgd1' };
        const admitted = await send('provider-completes-while-gateway-dead', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('provider-completes-while-gateway-dead', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('provider-completes-while-gateway-dead', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('provider-completes-while-gateway-dead', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 2_000 });

        await send('provider-completes-while-gateway-dead', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap = (await send('provider-completes-while-gateway-dead', { operation: 'inspect' })).body.output;
        check('provider-completes-while-gateway-dead.single-settlement', snap.requests[0]?.data?.state, 'completed');
        check('provider-completes-while-gateway-dead.slot-released', activeGlobal(snap), 0);
        return { state: snap.requests[0]?.data?.state };
    });

    // 5. Two recovery workers claim race
    await runCase('two-recovery-workers-claim-race', async check => {
        const req = { uid: 'erin', requestId: 'trwcr-1', category: 'chat', model: 'fake', payloadHash: 'htrwcr1' };
        const admitted = await send('two-recovery-workers-claim-race', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('two-recovery-workers-claim-race', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('two-recovery-workers-claim-race', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('two-recovery-workers-claim-race', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 2_000 });

        const [c1, c2] = await Promise.all([
            send('two-recovery-workers-claim-race', { operation: 'claim', ...req, owner: 'rec-1', logicalTimeMs: 12_000 }),
            send('two-recovery-workers-claim-race', { operation: 'claim', ...req, owner: 'rec-2', logicalTimeMs: 12_000 }),
        ]);
        const statuses = [c1.body.output.status, c2.body.output.status].sort();
        const winner = c1.body.output.status === 'claimed'
            ? { owner: 'rec-1', fence: c1.body.output.record.fence }
            : { owner: 'rec-2', fence: c2.body.output.record.fence };

        await send('two-recovery-workers-claim-race', { operation: 'reconcile', ...req, owner: winner.owner, fence: winner.fence, logicalTimeMs: 12_000 });
        const snap = (await send('two-recovery-workers-claim-race', { operation: 'inspect' })).body.output;

        check('two-recovery-workers-claim-race.one-winner', statuses, ['claimed', 'lease-owned']);
        check('two-recovery-workers-claim-race.one-lease-owned-loser', statuses.includes('lease-owned'), true);
        check('two-recovery-workers-claim-race.single-fence-increment', snap.requests[0]?.data?.fence, 2);
        return { statuses, winner };
    });

    // 6. Recovery worker dies after claim
    await runCase('recovery-worker-dies-after-claim', async check => {
        const req = { uid: 'frank', requestId: 'rwdac-1', category: 'chat', model: 'fake', payloadHash: 'hrwdac1' };
        const admitted = await send('recovery-worker-dies-after-claim', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('recovery-worker-dies-after-claim', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('recovery-worker-dies-after-claim', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('recovery-worker-dies-after-claim', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 2_000 });

        // First recovery worker claims at 12_000 (fence = 2), then dies
        await send('recovery-worker-dies-after-claim', { operation: 'claim', ...req, owner: 'rec-1', logicalTimeMs: 12_000 });
        // Second recovery worker takes over after claim lease expires at 23_000 (fence = 3)
        await send('recovery-worker-dies-after-claim', { operation: 'sweep', owner: 'rec-2', logicalTimeMs: 23_000 });
        const snap = (await send('recovery-worker-dies-after-claim', { operation: 'inspect' })).body.output;

        check('recovery-worker-dies-after-claim.no-duplicate-provider-call', snap.provider[0]?.data?.startAttempts, 1);
        check('recovery-worker-dies-after-claim.second-worker-completes', snap.requests[0]?.data?.state, 'completed');
        check('recovery-worker-dies-after-claim.fence-reaches-3', snap.requests[0]?.data?.fence, 3);
        return { fence: snap.requests[0]?.data?.fence };
    });

    // 7. Stale observation after takeover
    await runCase('stale-observation-after-takeover', async check => {
        const req = { uid: 'grace', requestId: 'soat-1', category: 'chat', model: 'fake', payloadHash: 'hsoat1' };
        const admitted = await send('stale-observation-after-takeover', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('stale-observation-after-takeover', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('stale-observation-after-takeover', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('stale-observation-after-takeover', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 2_000 });

        const c1 = await send('stale-observation-after-takeover', { operation: 'claim', ...req, owner: 'rec-1', logicalTimeMs: 12_000 });
        const c2 = await send('stale-observation-after-takeover', { operation: 'claim', ...req, owner: 'rec-2', logicalTimeMs: 23_000 });

        // Stale rec-1 tries to reconcile with fence 2
        const stale = await send('stale-observation-after-takeover', { operation: 'reconcile', ...req, owner: 'rec-1', fence: c1.body.output.record.fence, logicalTimeMs: 23_000 });
        // Current rec-2 reconciles with fence 3
        await send('stale-observation-after-takeover', { operation: 'reconcile', ...req, owner: 'rec-2', fence: c2.body.output.record.fence, logicalTimeMs: 23_000 });
        const snap = (await send('stale-observation-after-takeover', { operation: 'inspect' })).body.output;

        check('stale-observation-after-takeover.stale-worker-rejected', stale.body.error, 'stale-owner');
        check('stale-observation-after-takeover.slot-released-once', activeGlobal(snap), 0);
        return { staleError: stale.body.error };
    });

    // 8. Settlement commits response lost
    await runCase('settlement-commits-response-lost', async check => {
        const req = { uid: 'heidi', requestId: 'scrl-1', category: 'chat', model: 'fake', payloadHash: 'hscrl1' };
        const admitted = await send('settlement-commits-response-lost', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('settlement-commits-response-lost', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('settlement-commits-response-lost', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('settlement-commits-response-lost', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 2_000 });
        await send('settlement-commits-response-lost', { operation: 'settle', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 3_000 });

        const claim = await send('settlement-commits-response-lost', { operation: 'claim', ...req, owner: 'rec-1', logicalTimeMs: 15_000 });
        const snap = (await send('settlement-commits-response-lost', { operation: 'inspect' })).body.output;

        check('settlement-commits-response-lost.no-double-decrement', activeGlobal(snap), 0);
        check('settlement-commits-response-lost.terminal-recognized', claim.body.output.status, 'already-terminal');
        return { claimStatus: claim.body.output.status };
    });

    // 9. Stop acknowledged not confirmed
    await runCase('stop-acknowledged-not-confirmed', async check => {
        const req = { uid: 'ivan', requestId: 'sanc-1', category: 'chat', model: 'fake', payloadHash: 'hsanc1' };
        const admitted = await send('stop-acknowledged-not-confirmed', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('stop-acknowledged-not-confirmed', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('stop-acknowledged-not-confirmed', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('stop-acknowledged-not-confirmed', { operation: 'provider-stop', ...req, logicalTimeMs: 2_000 });

        await send('stop-acknowledged-not-confirmed', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap1 = (await send('stop-acknowledged-not-confirmed', { operation: 'inspect' })).body.output;
        check('stop-acknowledged-not-confirmed.retained-while-stop-pending', activeGlobal(snap1), 1);

        await send('stop-acknowledged-not-confirmed', { operation: 'provider-finish', ...req, outcome: 'cancelled', logicalTimeMs: 24_000 });
        await send('stop-acknowledged-not-confirmed', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 25_000 });
        const snap2 = (await send('stop-acknowledged-not-confirmed', { operation: 'inspect' })).body.output;
        check('stop-acknowledged-not-confirmed.released-after-confirmed-cancel', activeGlobal(snap2), 0);
        return { finalActive: activeGlobal(snap2) };
    });

    // 10. Provider status transiently unavailable
    await runCase('provider-status-transiently-unavailable', async check => {
        const req = { uid: 'judy', requestId: 'pstu-1', category: 'chat', model: 'fake', payloadHash: 'hpstu1' };
        const admitted = await send('provider-status-transiently-unavailable', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('provider-status-transiently-unavailable', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('provider-status-transiently-unavailable', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('provider-status-transiently-unavailable', { operation: 'provider-unavailable', ...req, unavailable: true, logicalTimeMs: 2_000 });

        await send('provider-status-transiently-unavailable', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap1 = (await send('provider-status-transiently-unavailable', { operation: 'inspect' })).body.output;
        check('provider-status-transiently-unavailable.no-guessed-termination', activeGlobal(snap1), 1);

        await send('provider-status-transiently-unavailable', { operation: 'provider-unavailable', ...req, unavailable: false, logicalTimeMs: 24_000 });
        await send('provider-status-transiently-unavailable', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 24_000 });
        await send('provider-status-transiently-unavailable', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 25_000 });
        const snap2 = (await send('provider-status-transiently-unavailable', { operation: 'inspect' })).body.output;
        check('provider-status-transiently-unavailable.recovered-when-available', activeGlobal(snap2), 0);
        return { finalActive: activeGlobal(snap2) };
    });

    // 11. Provider forever unobservable
    await runCase('provider-forever-unobservable', async check => {
        const req = { uid: 'karl', requestId: 'pfu-1', category: 'chat', model: 'fake', payloadHash: 'hpfu1' };
        const admitted = await send('provider-forever-unobservable', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('provider-forever-unobservable', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 });
        await send('provider-forever-unobservable', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 });
        await send('provider-forever-unobservable', { operation: 'provider-hide', ...req, hidden: true, logicalTimeMs: 2_000 });

        await send('provider-forever-unobservable', { operation: 'sweep', owner: 'rec-1', logicalTimeMs: 12_000 });
        const snap = (await send('provider-forever-unobservable', { operation: 'inspect' })).body.output;
        const record = snap.requests[0]?.data;

        check('provider-forever-unobservable.slot-retained', activeGlobal(snap), 1);
        check('provider-forever-unobservable.explicit-quarantine-reason', record?.quarantineReason, 'provider-unobservable');
        return { quarantineReason: record?.quarantineReason };
    });

    // 12. Reconciler backlog spans pages
    await runCase('reconciler-backlog-spans-pages', async check => {
        // Create 5 requests across 3 users: req-0 stuck unobservable, req-1..4 completed
        for (let i = 0; i < 5; i++) {
            const uid = `u-${i % 3}`;
            const req = { uid, requestId: `backlog-${i}`, category: 'chat', model: 'fake', payloadHash: `hb${i}` };
            const admitted = await send('reconciler-backlog-spans-pages', { operation: 'admit', ...req, owner: 'gw-a', logicalTimeMs: 1_000 + i });
            if (admitted.body.output.status !== 'admitted') continue;
            await send('reconciler-backlog-spans-pages', { operation: 'dispatch', ...req, owner: 'gw-a', fence: admitted.body.output.record.fence, logicalTimeMs: 1_000 + i });
            await send('reconciler-backlog-spans-pages', { operation: 'provider-start', ...req, owner: 'gw-a', logicalTimeMs: 1_000 + i });
            if (i === 0) {
                await send('reconciler-backlog-spans-pages', { operation: 'provider-hide', ...req, hidden: true, logicalTimeMs: 2_000 });
            } else {
                await send('reconciler-backlog-spans-pages', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 2_000 });
            }
        }
        await send('reconciler-backlog-spans-pages', { operation: 'sweep', owner: 'rec-1', batchSize: 2, logicalTimeMs: 15_000 });
        const snap = (await send('reconciler-backlog-spans-pages', { operation: 'inspect' })).body.output;
        const completedCount = snap.requests.filter(r => r.data.state === 'completed').length;
        const quarantinedCount = snap.requests.filter(r => Boolean(r.data.quarantineReason)).length;

        check('reconciler-backlog-spans-pages.all-completed-jobs-released', completedCount, 2);
        check('reconciler-backlog-spans-pages.stuck-job-quarantined', quarantinedCount, 1);
        return { completedCount, quarantinedCount };
    });

    // 13. Clock offsets and renew/takeover races
    await runCase('clock-offsets-and-renew-races', async check => {
        const req = { uid: 'jan', requestId: 'clock-1', category: 'chat', model: 'fake', payloadHash: 'hclock1' };
        // Gateway admits at its lagged clock 3_000 (leaseUntil = 13_000)
        const admitted = await send('clock-offsets-and-renew-races', { operation: 'admit', ...req, owner: 'gw-skewed', logicalTimeMs: 3_000 });
        await send('clock-offsets-and-renew-races', { operation: 'dispatch', ...req, owner: 'gw-skewed', fence: admitted.body.output.record.fence, logicalTimeMs: 3_000 });
        await send('clock-offsets-and-renew-races', { operation: 'provider-start', ...req, owner: 'gw-skewed', logicalTimeMs: 3_000 });
        await send('clock-offsets-and-renew-races', { operation: 'provider-finish', ...req, outcome: 'completed', logicalTimeMs: 4_000 });

        // Recovery worker claims at cluster clock 16_000 (> leaseUntil 13_000)
        const claim = await send('clock-offsets-and-renew-races', { operation: 'claim', ...req, owner: 'rec-1', logicalTimeMs: 16_000 });
        // Skewed gateway attempts heartbeat at its lagged clock 8_000 with old fence
        const hb = await send('clock-offsets-and-renew-races', { operation: 'heartbeat', ...req, owner: 'gw-skewed', fence: admitted.body.output.record.fence, logicalTimeMs: 8_000 });
        await send('clock-offsets-and-renew-races', { operation: 'reconcile', ...req, owner: 'rec-1', fence: claim.body.output.record.fence, logicalTimeMs: 16_000 });
        const snap = (await send('clock-offsets-and-renew-races', { operation: 'inspect' })).body.output;

        check('clock-offsets-and-renew-races.stale-heartbeat-rejected', hb.body.error, 'stale-owner');
        check('clock-offsets-and-renew-races.recovery-owner-settles', activeGlobal(snap), 0);
        return { renewError: hb.body.error };
    });

    const failed = assertions.filter(a => !a.passed);
    return {
        measurementId,
        successful: failed.length === 0,
        commands,
        cases,
        assertions,
        finalState: Object.fromEntries(cases.map(c => [c.id, c.state])),
        failure: failed[0] ?? null,
    };
}
