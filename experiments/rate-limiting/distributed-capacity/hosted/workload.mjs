import { isDeepStrictEqual } from 'node:util';

// The same bounded HTTP workload runs against Pyric and the deployed gateway.
// No reset, direct database writes, deployment or automatic transport retry.
export async function runHostedWorkload({ measurementId, command, onCase = (_row) => {} }) {
    if (!/^[a-z0-9-]{1,50}$/.test(measurementId)) throw new Error('Invalid measurement ID');
    const result = { schemaVersion: 3, measurementId, cases: [], assertions: [], commands: 0, routingRecoveries: [], finalState: {},
        coverage: { actualProcessCrashTested: false, provider: 'durable state-machine fixture', clock: 'controlled logical milliseconds',
            unsupported: ['commit-ack-lost: no transaction acknowledgment fault control', 'invalid-state: no corruption control',
                'provider-unobservable: no provider observation fault control', 'unsafe-expiry: unsafe control is not deployed'],
            adapted: ['Crash-before-dispatch and crash-during-inference are abandoned state / lease takeovers, not process crashes.',
                'A new fence does not imply a new gateway process. Actual instance IDs are recorded.',
                'Provider completion is supplied by the operator; no independent remote inference runs.',
                'Limits are fixed at global=3/user=2/lease=30000ms; original local scenario limits varied.'] } };
    let scenario = 'preflight', time = 1000;
    const check = (name, actual, expected) => result.assertions.push({ caseId: scenario, name, actual, expected, passed: isDeepStrictEqual(actual, expected) });
    const call = async (space, operation, request = {}, extra = {}) => {
        if (++result.commands > 200) throw new Error('Client command budget exceeded');
        return command(space, { operation, ...request, logicalTimeMs: time, ...extra });
    };
    async function settleAll(promises) {
        const rows = await Promise.allSettled(promises);
        const failure = rows.find(row => row.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return rows.map(row => row.status === 'fulfilled' ? row.value : undefined);
    }
    const requireOk = response => { if (response.status !== 200) throw new Error(`Command failed: ${response.status}/${response.body.error}`); return response.body.result; };
    const inspect = async space => requireOk(await call(space, 'inspect', { uid: 'alice', requestId: `${measurementId}-inspect` }));
    const request = (suffix, uid = 'alice') => ({ uid, requestId: `${measurementId}-${suffix}` });
    const active = state => state.capacity.find(row => row.id === 'global')?.data.active ?? 0;
    // Routing can move a follow-up command to another process. Keep every failed
    // attempt, then explicitly wait in logical time and acquire a fresh fence.
    async function owned(space, operation, req, fence) {
        for (let i = 0; i < 5; i++) {
            const response = await call(space, operation, req, { fence });
            if (response.status === 200) return response.body.result;
            if (!['stale-owner', 'lease-expired'].includes(response.body.error)) return requireOk(response);
            result.routingRecoveries.push({ caseId: scenario, operation, code: response.body.error, fence });
            time += 31000;
            fence = requireOk(await call(space, 'takeover', req)).fence;
        }
        throw new Error('Owner routing could not stabilize in five attempts');
    }
    async function finish(space, req, fence = 1, outcome = 'completed') {
        requireOk(await call(space, 'provider-finish', req, { outcome }));
        return owned(space, 'reconcile', req, fence);
    }
    async function run(id, body) {
        scenario = id; time += 100000;
        const start = result.assertions.length;
        const row = { id, status: 'running', startedAt: new Date().toISOString() };
        result.cases.push(row);
        try {
            await body();
            row.status = result.assertions.slice(start).every(assertion => assertion.passed) ? 'passed' : 'failed';
        } catch (error) { row.status = 'incomplete'; row.error = String(error.message); }
        row.finishedAt = new Date().toISOString(); onCase(row);
        if (row.status !== 'passed') throw new Error(`Stopped after ${id}: ${row.error ?? 'assertion failure'}`);
    }
    try {
        // Existing runs share fixed server namespaces. Refuse to mix evidence or
        // overwrite records. Future runs require explicitly isolated namespaces.
        for (const space of ['capacity-shared', 'recovery']) {
            const state = await inspect(space);
            if (state.requests.length || state.provider.length || active(state)) throw new Error(`Namespace ${space} is not empty; refusing to reuse it`);
        }
        await run('concurrent', async () => {
            const requests = Array.from({ length: 16 }, (_, i) => request(`parallel-${i}`, i % 2 ? 'alice' : 'bob'));
            const responses = await settleAll(requests.map(req => call('capacity-shared', 'start', req)));
            const started = responses.map((response, i) => ({ result: requireOk(response), req: requests[i] })).filter(row => row.result.status === 'started');
            const state = await inspect('capacity-shared');
            check('three admissions', started.length, 3);
            check('thirteen busy', responses.filter(row => row.body.result?.status === 'busy').length, 13);
            check('global bound', active(state), 3);
            check('user bound', Math.max(...state.users.map(row => row.data.active)) <= 2, true);
            check('three running fixture jobs', state.provider.filter(row => row.data.state === 'running').length, 3);
            check('counters match reservations', active(state), state.requests.length);
            for (const row of started) await finish('capacity-shared', row.req, row.result.record.fence);
            check('capacity released', active(await inspect('capacity-shared')), 0);
        });
        await run('duplicate-admission', async () => {
            const req = request('duplicate');
            const responses = await settleAll(Array.from({ length: 8 }, () => call('capacity-shared', 'start', req)));
            responses.forEach(requireOk);
            check('one start response', responses.filter(row => row.body.result.status === 'started').length, 1);
            check('seven duplicate responses', responses.filter(row => row.body.result.status === 'duplicate').length, 7);
            const state = await inspect('capacity-shared');
            check('single capacity debit', active(state), 1);
            check('one active fixture job', state.provider.filter(row => row.data.state === 'running').length, 1);
            await finish('capacity-shared', req);
        });
        await run('lease-renewal', async () => {
            const req = request('renewal');
            const reserved = requireOk(await call('capacity-shared', 'reserve', req)).record;
            time += 29000;
            const renewed = await owned('capacity-shared', 'renew', req, reserved.fence);
            check('renewal extends lease', renewed.leaseUntil > reserved.leaseUntil, true);
            check('lease uses current command time', renewed.leaseUntil, time + 30000);
            time += 2000;
            const denied = await call('capacity-shared', 'takeover', req);
            check('early takeover rejected', [denied.status, denied.body.error], [409, 'lease-owned']);
            const started = await owned('capacity-shared', 'resume', req, renewed.fence);
            await finish('capacity-shared', req, started.record.fence);
        });
        await run('abandoned-before-dispatch', async () => {
            const req = request('before-dispatch');
            requireOk(await call('capacity-shared', 'reserve', req));
            time += 31000;
            const taken = requireOk(await call('capacity-shared', 'takeover', req));
            check('fence advanced', taken.fence, 2);
            check('undispatched reservation remains resumable', taken.state, 'reserved');
            const started = await owned('capacity-shared', 'resume', req, taken.fence);
            check('resumed execution running', started.record.state, 'running');
            await finish('capacity-shared', req, started.record.fence);
            check('released after completion', active(await inspect('capacity-shared')), 0);
        });
        await run('running-takeover-and-stale-fence', async () => {
            const req = request('running');
            requireOk(await call('capacity-shared', 'start', req)); time += 31000;
            const taken = requireOk(await call('capacity-shared', 'takeover', req));
            check('fence advanced', taken.fence, 2);
            check('takeover starts uncertain', taken.state, 'unknown');
            check('lease expiry retains capacity', active(await inspect('capacity-shared')), 1);
            for (const operation of ['intent', 'renew', 'reconcile']) {
                const denied = await call('capacity-shared', operation, req, { fence: 1 });
                check(`${operation} stale fence rejected`, [denied.status, denied.body.error], [409, 'stale-owner']);
            }
            const observed = await owned('capacity-shared', 'reconcile', req, taken.fence);
            check('existing provider found running', observed.state, 'running');
            check('no second active provider job', (await inspect('capacity-shared')).provider.filter(row => row.data.state === 'running').length, 1);
            await finish('capacity-shared', req, observed.fence);
        });
        await run('recovery-race', async () => {
            const req = request('race'); requireOk(await call('capacity-shared', 'reserve', req)); time += 31000;
            const responses = await settleAll(Array.from({ length: 8 }, () => call('capacity-shared', 'takeover', req)));
            const winners = responses.filter(row => row.status === 200);
            check('one recovery winner', winners.length, 1);
            check('seven live lease rejections', responses.filter(row => row.status === 409 && row.body.error === 'lease-owned').length, 7);
            check('single fence increment', winners[0]?.body.result.fence, 2);
            check('capacity retained', active(await inspect('capacity-shared')), 1);
            const resumed = await owned('capacity-shared', 'resume', req, winners[0].body.result.fence);
            await finish('capacity-shared', req, resumed.record.fence);
        });
        for (const outcome of ['completed', 'cancelled']) await run(`confirmed-${outcome}`, async () => {
            const req = request(outcome); requireOk(await call('capacity-shared', 'start', req));
            requireOk(await call('capacity-shared', 'provider-finish', req, { outcome }));
            check('terminal evidence alone retains capacity until reconciliation', active(await inspect('capacity-shared')), 1);
            time += 31000;
            const taken = requireOk(await call('capacity-shared', 'takeover', req));
            const settled = await owned('capacity-shared', 'reconcile', req, taken.fence);
            check('confirmed outcome persisted', settled.state, outcome);
            check('capacity released', active(await inspect('capacity-shared')), 0);
            requireOk(await call('capacity-shared', 'reconcile', req, { fence: settled.fence }));
            check('duplicate settlement does not decrement twice', active(await inspect('capacity-shared')), 0);
            check('terminal duplicate not dispatched', requireOk(await call('capacity-shared', 'start', req)).status, 'duplicate');
        });
        await run('dispatch-uncertain', async () => {
            for (let i = 0; i < 3; i++) {
                const req = request(`uncertain-${i}`, i < 2 ? 'alice' : 'bob');
                const reserved = requireOk(await call('recovery', 'reserve', req));
                await owned('recovery', 'intent', req, reserved.record.fence); time += 31000;
                const taken = requireOk(await call('recovery', 'takeover', req));
                const observed = await owned('recovery', 'reconcile', req, taken.fence);
                check(`uncertain intent ${i} quarantined`, observed.state, 'unknown');
            }
            const state = await inspect('recovery');
            check('capacity retained for all uncertain work', active(state), 3);
            check('no blind redispatch', state.provider.length, 0);
            check('new admission blocked', requireOk(await call('recovery', 'start', request('replacement', 'carol'))).status, 'busy');
        });
    } catch (error) { result.failure = String(error.message); }
    for (const space of ['capacity-shared', 'recovery']) {
        try { result.finalState[space] = await inspect(space); }
        catch (error) {
            result.finalState[space] = { error: String(error.message) };
            result.failure = result.failure ?? `Final state unavailable for ${space}`;
        }
    }
    result.successful = !result.failure && result.cases.length === 9 && result.assertions.every(row => row.passed);
    return result;
}
