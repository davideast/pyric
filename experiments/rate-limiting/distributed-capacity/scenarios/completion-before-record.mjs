export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['released exactly once', 'one remote dispatch', 'retry remains duplicate', 'durable terminal state'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'before-record' };
    const a = await cluster.spawn('a');
    const started = await a.command('start', request);
    provider.finish(started.record.providerKey);
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b');
    await b.command('takeover', request);
    await Promise.all([b.command('reconcile', request), b.command('reconcile', request)]);
    const retry = await b.command('start', request);
    const state = await cluster.snapshot();
    check('released exactly once', state.capacity[0].data.active, 0);
    check('one remote dispatch', provider.snapshot().startAttempts, 1);
    check('retry remains duplicate', retry.status, 'duplicate');
    check('durable terminal state', state.requests[0].data.state, 'completed');
    return { finalActive: state.capacity[0].data.active, retry: retry.status };
}
