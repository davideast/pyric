// Hosted HTTP workload executing all 10 fair-allocation scenarios against
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

    // 1. Balanced backlogged users
    await runCase('balanced-backlogged-users', async check => {
        for (const uid of ['alice', 'bob', 'carol']) {
            for (let i = 0; i < 2; i++) {
                await send('balanced-backlogged-users', {
                    operation: 'enqueue', uid, requestId: `bal-${uid}-${i}`, payloadHash: `ph-bal-${uid}-${i}`, logicalTimeMs: 1_000 + i,
                });
            }
        }
        const s1 = await send('balanced-backlogged-users', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });
        const s2 = await send('balanced-backlogged-users', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });
        const s3 = await send('balanced-backlogged-users', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });
        const snap = (await send('balanced-backlogged-users', { operation: 'inspect' })).body.output;

        const admittedUids = [s1.body.output.record.uid, s2.body.output.record.uid, s3.body.output.record.uid];
        check('balanced-backlogged-users.equal-rotation', admittedUids, ['alice', 'bob', 'carol']);
        check('balanced-backlogged-users.global-active-bounded', activeGlobal(snap), 3);
        return { admittedUids };
    });

    // 2. One noisy user, two quiet users (FIFO vs Round-Robin)
    await runCase('one-noisy-two-quiet-users', async check => {
        // Alice bursts 3 items, then Bob and Carol each send 1 item
        for (let i = 0; i < 3; i++) {
            await send('one-noisy-two-quiet-users', {
                operation: 'enqueue', uid: 'alice', requestId: `nq-alice-${i}`, payloadHash: `ph-nqa-${i}`, logicalTimeMs: 1_000 + i,
            });
        }
        await send('one-noisy-two-quiet-users', {
            operation: 'enqueue', uid: 'bob', requestId: 'nq-bob-0', payloadHash: 'ph-nqb-0', logicalTimeMs: 1_010,
        });
        await send('one-noisy-two-quiet-users', {
            operation: 'enqueue', uid: 'carol', requestId: 'nq-carol-0', payloadHash: 'ph-nqc-0', logicalTimeMs: 1_011,
        });

        const r1 = await send('one-noisy-two-quiet-users', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });
        const r2 = await send('one-noisy-two-quiet-users', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });
        const r3 = await send('one-noisy-two-quiet-users', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });

        const selectedUids = [r1.body.output.record.uid, r2.body.output.record.uid, r3.body.output.record.uid];
        check('one-noisy-two-quiet-users.both-quiet-users-admitted-immediately', selectedUids, ['alice', 'bob', 'carol']);
        check('one-noisy-two-quiet-users.noisy-user-burst-held-in-queue', r1.body.output.record.requestId, 'nq-alice-0');
        return { selectedUids };
    });

    // 3. Short and long operations
    await runCase('short-and-long-operations', async check => {
        // Alice enqueues 3 long jobs (1000ms), Bob enqueues 1 short job (200ms)
        for (let i = 0; i < 3; i++) {
            await send('short-and-long-operations', {
                operation: 'enqueue', uid: 'alice', requestId: `sl-alice-${i}`, payloadHash: `ph-sla-${i}`, durationMs: 1_000, logicalTimeMs: 1_000 + i,
            });
        }
        await send('short-and-long-operations', {
            operation: 'enqueue', uid: 'bob', requestId: 'sl-bob-0', payloadHash: 'ph-slb-0', durationMs: 200, logicalTimeMs: 1_010,
        });

        const s1 = await send('short-and-long-operations', { operation: 'select-fifo', owner: 'disp-1', logicalTimeMs: 2_000 });
        const s2 = await send('short-and-long-operations', { operation: 'select-fifo', owner: 'disp-1', logicalTimeMs: 2_000 });
        // Alice is at perUser cap (2), so 3rd slot goes to Bob's short job even under FIFO
        const s3 = await send('short-and-long-operations', { operation: 'select-fifo', owner: 'disp-1', logicalTimeMs: 2_000 });

        check('short-and-long-operations.alice-capped-at-2', [s1.body.output.record.uid, s2.body.output.record.uid], ['alice', 'alice']);
        check('short-and-long-operations.short-job-bypasses-capped-long-user', s3.body.output.record.uid, 'bob');
        return { thirdSlotUid: s3.body.output.record.uid };
    });

    // 4. Distinct-user burst
    await runCase('distinct-user-burst', async check => {
        const immResults = [];
        for (let i = 0; i < 4; i++) {
            const res = await send('distinct-user-burst', {
                operation: 'admit-immediate', uid: `burst-u-${i}`, requestId: `burst-r-${i}`, payloadHash: `ph-br-${i}`, logicalTimeMs: 1_000,
            });
            immResults.push(res.body.output.status);
        }
        check('distinct-user-burst.immediate-admits-3-rejects-4th', immResults, [
            'execution-admitted', 'execution-admitted', 'execution-admitted', 'capacity-rejected',
        ]);
        return { immResults };
    });

    // 5. Duplicate offer storm
    await runCase('duplicate-offer-storm', async check => {
        const req = { uid: 'alice', requestId: 'dup-1', payloadHash: 'ph-dup-orig' };
        const e1 = await send('duplicate-offer-storm', { operation: 'enqueue', ...req, logicalTimeMs: 1_000 });
        const e2 = await send('duplicate-offer-storm', { operation: 'enqueue', ...req, logicalTimeMs: 1_001 });
        const mismatch = await send('duplicate-offer-storm', { operation: 'enqueue', uid: 'alice', requestId: 'dup-1', payloadHash: 'ph-dup-diff', logicalTimeMs: 1_002 });

        check('duplicate-offer-storm.idempotent-duplicate', [e1.body.output.status, e2.body.output.status], ['queue-admitted', 'duplicate']);
        check('duplicate-offer-storm.payload-mismatch-rejected', mismatch.body.error, 'payload_mismatch');
        return { e1: e1.body.output.status, e2: e2.body.output.status, mismatch: mismatch.body.error };
    });

    // 6. Queue overload
    await runCase('queue-overload', async check => {
        const results = [];
        for (let i = 0; i < 9; i++) {
            const r = await send('queue-overload', {
                operation: 'enqueue', uid: 'alice', requestId: `qo-${i}`, payloadHash: `ph-qo-${i}`, logicalTimeMs: 1_000 + i,
            });
            results.push(r.body.output);
        }
        check('queue-overload.first-8-admitted', results.slice(0, 8).every(r => r.status === 'queue-admitted'), true);
        check('queue-overload.ninth-rejected-user-queue-full', results[8].reason, 'user-queue-full');
        return { ninth: results[8] };
    });

    // 7. Queue cancellation and expiry
    await runCase('queue-cancellation-and-expiry', async check => {
        await send('queue-cancellation-and-expiry', { operation: 'enqueue', uid: 'alice', requestId: 'qce-cancel', payloadHash: 'ph-c', logicalTimeMs: 1_000 });
        await send('queue-cancellation-and-expiry', { operation: 'enqueue', uid: 'bob', requestId: 'qce-live', payloadHash: 'ph-l', logicalTimeMs: 1_001 });
        await send('queue-cancellation-and-expiry', { operation: 'enqueue', uid: 'carol', requestId: 'qce-expire', payloadHash: 'ph-e', logicalTimeMs: 1_002 });

        const cRes = await send('queue-cancellation-and-expiry', { operation: 'cancel-queued', uid: 'alice', requestId: 'qce-cancel', logicalTimeMs: 1_500 });
        await send('queue-cancellation-and-expiry', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 });
        const lateCancel = await send('queue-cancellation-and-expiry', { operation: 'cancel-queued', uid: 'bob', requestId: 'qce-live', logicalTimeMs: 2_500 });
        const expRes = await send('queue-cancellation-and-expiry', { operation: 'expire-queued', uid: 'carol', requestId: 'qce-expire', logicalTimeMs: 35_000 });

        check('queue-cancellation-and-expiry.cancelled', cRes.body.output.status, 'cancelled');
        check('queue-cancellation-and-expiry.dispatched-rejects-cancel', lateCancel.body.output.status, 'already-dispatched');
        check('queue-cancellation-and-expiry.expired', expRes.body.output.status, 'expired');
        return { cancelled: cRes.body.output.status, lateCancel: lateCancel.body.output.status, expired: expRes.body.output.status };
    });

    // 8. Unknown running work retains slot
    await runCase('unknown-running-work', async check => {
        await send('unknown-running-work', { operation: 'enqueue', uid: 'alice', requestId: 'unk-1', payloadHash: 'ph-unk', logicalTimeMs: 1_000 });
        const sel = await send('unknown-running-work', { operation: 'select-fifo', owner: 'disp-1', logicalTimeMs: 2_000 });
        await send('unknown-running-work', { operation: 'provider-hide', uid: 'alice', requestId: 'unk-1', hidden: true, logicalTimeMs: 3_000 });
        await send('unknown-running-work', { operation: 'quarantine', uid: 'alice', requestId: 'unk-1', owner: 'disp-1', fence: sel.body.output.record.fence, logicalTimeMs: 3_000 });

        const snap = (await send('unknown-running-work', { operation: 'inspect' })).body.output;
        check('unknown-running-work.slot-retained', activeGlobal(snap), 1);
        return { active: activeGlobal(snap) };
    });

    // 9. Selector restart and competing selectors
    await runCase('selector-restart-and-competing-selectors', async check => {
        for (const uid of ['alice', 'bob', 'carol']) {
            await send('selector-restart-and-competing-selectors', {
                operation: 'enqueue', uid, requestId: `sr-${uid}`, payloadHash: `ph-sr-${uid}`, logicalTimeMs: 1_000,
            });
        }
        const [s1, s2] = await Promise.all([
            send('selector-restart-and-competing-selectors', { operation: 'select-round-robin', owner: 'disp-1', logicalTimeMs: 2_000 }),
            send('selector-restart-and-competing-selectors', { operation: 'select-round-robin', owner: 'disp-2', logicalTimeMs: 2_000 }),
        ]);
        const s3 = await send('selector-restart-and-competing-selectors', { operation: 'select-round-robin', owner: 'disp-3', logicalTimeMs: 2_000 });

        const uids = [s1.body.output.record.uid, s2.body.output.record.uid, s3.body.output.record.uid].sort();
        check('selector-restart-and-competing-selectors.all-three-users-selected-once', uids, ['alice', 'bob', 'carol']);
        return { uids };
    });

    // 10. Allowance exhaustion interaction
    await runCase('allowance-exhaustion-interaction', async check => {
        for (let i = 0; i < 3; i++) {
            await send('allowance-exhaustion-interaction', {
                operation: 'enqueue', uid: 'alice', requestId: `ae-alice-${i}`, payloadHash: `ph-aea-${i}`, logicalTimeMs: 1_000 + i,
            });
        }
        await send('allowance-exhaustion-interaction', {
            operation: 'enqueue', uid: 'bob', requestId: 'ae-bob-0', payloadHash: 'ph-aeb-0', logicalTimeMs: 1_010,
        });

        const r1 = await send('allowance-exhaustion-interaction', { operation: 'select-fifo', owner: 'disp-1', lowAllowance: true, logicalTimeMs: 2_000 });
        const r2 = await send('allowance-exhaustion-interaction', { operation: 'select-fifo', owner: 'disp-1', lowAllowance: true, logicalTimeMs: 2_000 });
        // Finish r1 to free an execution slot for alice
        await send('allowance-exhaustion-interaction', { operation: 'provider-finish', uid: 'alice', requestId: 'ae-alice-0', outcome: 'completed', logicalTimeMs: 3_000 });
        await send('allowance-exhaustion-interaction', { operation: 'settle', uid: 'alice', requestId: 'ae-alice-0', owner: 'disp-1', fence: r1.body.output.record.fence, logicalTimeMs: 3_000 });

        const r3 = await send('allowance-exhaustion-interaction', { operation: 'select-fifo', owner: 'disp-1', lowAllowance: true, logicalTimeMs: 3_000 });
        const r4 = await send('allowance-exhaustion-interaction', { operation: 'select-fifo', owner: 'disp-1', lowAllowance: true, logicalTimeMs: 3_000 });

        check('allowance-exhaustion-interaction.third-alice-quota-denied', r3.body.output.status, 'quota-denied');
        check('allowance-exhaustion-interaction.bob-admitted', r4.body.output.record.uid, 'bob');
        return { r2: r2.body.output.status, r3: r3.body.output.status, r4: r4.body.output.record.uid };
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
