import { isDeepStrictEqual } from 'node:util';

// Bounded HTTP workload controller. Runs the exact same schedules against
// local Pyric HTTP (--local) and deployed Cloud Run + Firestore.
// Each case uses its own per-measurement isolated namespace.
export async function runHostedWorkload({ measurementId, command, onCase = (_row) => {} }) {
    if (!/^[a-z0-9-]{1,50}$/.test(measurementId)) throw new Error('Invalid measurement ID');

    const caseNames = [
        'normal-chat',
        'normal-agent',
        'capacity-busy',
        'quota-exhausted',
        'duplicate-same-payload',
        'duplicate-conflict',
        'pre-dispatch-cancel',
        'cancel-vs-dispatch-race',
        'refund-saturation',
        'provider-unknown-quarantine',
        'idempotent-settlement',
        'stale-fence-rejection',
    ];
    const spaces = Object.fromEntries(caseNames.map(name => [name, `${measurementId.slice(0, 8)}-${name}`]));

    const result = {
        schemaVersion: 1,
        measurementId,
        cases: [],
        assertions: [],
        commands: 0,
        finalState: {},
        coverage: {
            actualProcessCrashTested: false,
            provider: 'durable Firestore state-machine fixture; no real AI calls',
            clock: 'controlled logical milliseconds',
            unsupported: [
                'crash-before-commit: no pre-commit transaction fault hook on hosted gateway',
                'ack-lost: no post-commit ack-drop fault hook on hosted gateway',
                'native-retry: native contention retries occur organically under parallel load',
                'split-admission-control: unsafe variant is never deployed to Cloud Run',
            ],
            adapted: [
                'Each case executes in an isolated per-measurement namespace.',
                'Provider start/finish/hide transitions are durable Firestore documents.',
                'Explicit owner identity preserves deterministic multi-gateway race testing across load-balanced containers.',
            ],
        },
    };

    let scenario = 'preflight', time = 1000;
    const check = (name, actual, expected) =>
        result.assertions.push({ caseId: scenario, name, actual, expected, passed: isDeepStrictEqual(actual, expected) });

    const call = async (space, operation, request = {}, extra = {}) => {
        if (++result.commands > 200) throw new Error('Client command budget exceeded');
        return command(space, { operation, owner: 'gw-a', ...request, logicalTimeMs: time, ...extra });
    };

    async function settleAll(promises) {
        const rows = await Promise.allSettled(promises);
        const failure = rows.find(row => row.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return rows.map(row => row.status === 'fulfilled' ? row.value : undefined);
    }

    const requireOk = response => {
        if (response.status !== 200) throw new Error(`Command failed: ${response.status}/${response.body?.error}`);
        return response.body.result;
    };
    const inspect = async space => requireOk(await call(space, 'inspect', { uid: 'alice', requestId: 'inspect' }));
    const active  = state => state.capacity.find(row => row.id === 'global')?.data.active ?? 0;

    async function run(id, body) {
        scenario = id;
        time += 10000;
        const space = spaces[id];
        const start = result.assertions.length;
        const row = { id, space, status: 'running', startedAt: new Date().toISOString() };
        result.cases.push(row);
        try {
            const initial = await inspect(space);
            if (initial.requests.length || initial.quotas.length || active(initial))
                throw new Error(`Namespace ${space} is not empty`);
            await body(space);
            row.status = result.assertions.slice(start).every(a => a.passed) ? 'passed' : 'failed';
        } catch (error) {
            row.status = 'incomplete';
            row.error = String(error.message);
        }
        row.finishedAt = new Date().toISOString();
        onCase(row);
        if (row.status !== 'passed') throw new Error(`Stopped after ${id}: ${row.error ?? 'assertion failure'}`);
    }

    try {
        await run('normal-chat', async space => {
            const req = { uid: 'alice', requestId: 'chat-1', category: 'chat', model: 'fake', payloadHash: 'h-chat-1' };
            const res = requireOk(await call(space, 'start', req));
            const state = await inspect(space);
            check('normal-chat.one-debit', state.quotas.some(d => d.data.buckets?.chat !== undefined), true);
            check('normal-chat.one-provider-job', state.provider.length, 1);
            check('normal-chat.slot-released', active(state), 0);
            check('normal-chat.state-completed', res.record.state, 'completed');
        });

        await run('normal-agent', async space => {
            const req = { uid: 'alice', requestId: 'agent-1', category: 'agent', model: 'fake', payloadHash: 'h-agent-1' };
            const res = requireOk(await call(space, 'start', req));
            const state = await inspect(space);
            check('normal-agent.one-debit', state.quotas.some(d => d.data.buckets?.agent !== undefined), true);
            check('normal-agent.slot-released', active(state), 0);
            check('normal-agent.state-completed', res.record.state, 'completed');
        });

        await run('capacity-busy', async space => {
            for (let i = 0; i < 3; i++) {
                const admitted = requireOk(await call(space, 'admit', {
                    uid: `user-${i}`, requestId: `slot-${i}`, category: 'chat', model: 'fake', payloadHash: `h-${i}`,
                }));
                check(`capacity-busy.admitted-${i}`, admitted.status, 'admitted');
            }
            const denied = requireOk(await call(space, 'admit', {
                uid: 'overflow', requestId: 'slot-ov', category: 'chat', model: 'fake', payloadHash: 'h-ov',
            }));
            const state = await inspect(space);
            check('capacity-busy.busy-response', denied.status, 'busy');
            check('capacity-busy.no-overflow-debit', state.quotas.length, 3);
            check('capacity-busy.global-bound-3', active(state), 3);
        });

        await run('quota-exhausted', async space => {
            const r1 = requireOk(await call(space, 'admit', { uid: 'bob', requestId: 'a1', category: 'agent', model: 'fake', payloadHash: 'ha1' }));
            const r2 = requireOk(await call(space, 'admit', { uid: 'bob', requestId: 'a2', category: 'agent', model: 'fake', payloadHash: 'ha2' }));
            const r3 = requireOk(await call(space, 'admit', { uid: 'bob', requestId: 'a3', category: 'agent', model: 'fake', payloadHash: 'ha3' }));
            const state = await inspect(space);
            check('quota-exhausted.first-two-admitted', [r1.status, r2.status], ['admitted', 'admitted']);
            check('quota-exhausted.third-denied', r3.status, 'quota_exhausted');
            check('quota-exhausted.active-bound-2', active(state), 2);
        });

        await run('duplicate-same-payload', async space => {
            const req = { uid: 'carol', requestId: 'dup-1', category: 'chat', model: 'fake', payloadHash: 'same-hash' };
            const responses = await settleAll(Array.from({ length: 6 }, () => call(space, 'admit', req)));
            responses.forEach(requireOk);
            const state = await inspect(space);
            check('duplicate-same-payload.one-admitted', responses.filter(r => r.body.result.status === 'admitted').length, 1);
            check('duplicate-same-payload.five-duplicates', responses.filter(r => r.body.result.status === 'duplicate').length, 5);
            check('duplicate-same-payload.single-debit', state.quotas.length, 1);
            check('duplicate-same-payload.single-slot', active(state), 1);
        });

        await run('duplicate-conflict', async space => {
            const first = requireOk(await call(space, 'admit', { uid: 'dave', requestId: 'conf-1', category: 'chat', model: 'fake', payloadHash: 'hash-a' }));
            const second = requireOk(await call(space, 'admit', { uid: 'dave', requestId: 'conf-1', category: 'chat', model: 'fake', payloadHash: 'hash-b' }));
            const state = await inspect(space);
            check('duplicate-conflict.first-admitted', first.status, 'admitted');
            check('duplicate-conflict.second-conflict', second.status, 'conflict');
            check('duplicate-conflict.original-intact', state.requests[0]?.data.payloadHash, 'hash-a');
        });

        await run('pre-dispatch-cancel', async space => {
            const req = { uid: 'hank', requestId: 'cancel-1', category: 'chat', model: 'fake', payloadHash: 'hcan1' };
            const admitted = requireOk(await call(space, 'admit', req));
            const refunded = requireOk(await call(space, 'refund', req, { fence: admitted.record.fence }));
            const state = await inspect(space);
            check('pre-dispatch-cancel.status-refunded', refunded.status, 'refunded');
            check('pre-dispatch-cancel.slot-released', active(state), 0);
            check('pre-dispatch-cancel.no-provider-job', state.provider.length, 0);
        });

        await run('cancel-vs-dispatch-race', async space => {
            const req = { uid: 'iris', requestId: 'race-1', category: 'chat', model: 'fake', payloadHash: 'hrace1' };
            const admitted = requireOk(await call(space, 'admit', req));
            const [disp, ref] = await settleAll([
                call(space, 'dispatch', req, { fence: admitted.record.fence }),
                call(space, 'refund', req, { fence: admitted.record.fence }),
            ]);
            const winners = [disp, ref].filter(r => r.status === 200).length;
            const state = await inspect(space);
            check('cancel-vs-dispatch-race.exactly-one-wins', winners, 1);
            check('cancel-vs-dispatch-race.consistent-slot', active(state), disp.status === 200 ? 1 : 0);
        });

        await run('refund-saturation', async space => {
            const req = { uid: 'ken', requestId: 'sat-1', category: 'chat', model: 'fake', payloadHash: 'hsat1' };
            const admitted = requireOk(await call(space, 'admit', req));
            // Advance logical clock so lazy refill replenishes bucket near capacity before refund
            time += 60000;
            const refunded = requireOk(await call(space, 'refund', req, { fence: admitted.record.fence }));
            check('refund-saturation.saturation-loss-positive', refunded.saturationLoss > 0, true);
        });

        await run('provider-unknown-quarantine', async space => {
            const req = { uid: 'mia', requestId: 'pu-1', category: 'chat', model: 'fake', payloadHash: 'hpu1' };
            const admitted = requireOk(await call(space, 'admit', req));
            requireOk(await call(space, 'dispatch', req, { fence: admitted.record.fence }));
            requireOk(await call(space, 'provider-start', req));
            requireOk(await call(space, 'provider-hide', req));
            const quarantined = requireOk(await call(space, 'quarantine', req, { fence: admitted.record.fence }));
            const state = await inspect(space);
            check('provider-unknown-quarantine.state-unknown', quarantined.state, 'unknown');
            check('provider-unknown-quarantine.debit-retained', quarantined.debitState, 'debited');
            check('provider-unknown-quarantine.slot-retained', active(state), 1);
        });

        await run('idempotent-settlement', async space => {
            const req = { uid: 'noah', requestId: 'sal-1', category: 'chat', model: 'fake', payloadHash: 'hsal1' };
            const admitted = requireOk(await call(space, 'admit', req));
            requireOk(await call(space, 'dispatch', req, { fence: admitted.record.fence }));
            requireOk(await call(space, 'provider-start', req));
            requireOk(await call(space, 'provider-finish', req, { outcome: 'completed' }));
            const s1 = requireOk(await call(space, 'settle', req, { fence: admitted.record.fence }));
            const s2 = requireOk(await call(space, 'settle', req, { fence: admitted.record.fence }));
            const state = await inspect(space);
            check('idempotent-settlement.first-completed', s1.state, 'completed');
            check('idempotent-settlement.second-completed', s2.state, 'completed');
            check('idempotent-settlement.counter-zero', active(state), 0);
        });

        await run('stale-fence-rejection', async space => {
            const req = { uid: 'olive', requestId: 'sf-1', category: 'chat', model: 'fake', payloadHash: 'hsf1' };
            const admitted = requireOk(await call(space, 'admit', req));
            for (const op of ['dispatch', 'refund']) {
                const denied = await call(space, op, req, { fence: 99 });
                check(`stale-fence-rejection.${op}-denied`, [denied.status, denied.body.error], [409, 'stale-owner']);
            }
            requireOk(await call(space, 'dispatch', req, { fence: admitted.record.fence }));
            requireOk(await call(space, 'provider-start', req));
            requireOk(await call(space, 'provider-finish', req, { outcome: 'completed' }));
            const settleDenied = await call(space, 'settle', req, { fence: 99 });
            check('stale-fence-rejection.settle-denied', [settleDenied.status, settleDenied.body.error], [409, 'stale-owner']);
        });
    } catch (error) {
        result.failure = String(error.message);
    }

    for (const [name, space] of Object.entries(spaces)) {
        try { result.finalState[name] = await inspect(space); }
        catch (error) {
            result.finalState[name] = { error: String(error.message) };
            result.failure = result.failure ?? `Final state unavailable for ${name}`;
        }
    }

    result.successful = !result.failure && result.cases.length === caseNames.length && result.assertions.every(row => row.passed);
    return result;
}
