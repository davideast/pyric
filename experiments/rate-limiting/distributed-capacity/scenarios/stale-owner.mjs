export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['stale transitions rejected', 'new owner retained', 'fence monotonic', 'new owner settles'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'stale-owner' };
    const a = await cluster.spawn('a'), b = await cluster.spawn('b');
    const started = await a.command('start', request);
    cluster.advance(101);
    const owned = await b.command('takeover', request);
    provider.finish(started.record.providerKey);
    const errors = [];
    for (const command of ['intent', 'renew', 'reconcile']) {
        try { await a.command(command, request, { fence: 1 }); errors.push('allowed'); } catch (error) { errors.push(error.message); }
    }
    const before = await cluster.snapshot();
    await b.command('reconcile', request);
    check('stale transitions rejected', errors, ['stale-owner', 'stale-owner', 'stale-owner']);
    check('new owner retained', before.requests[0].data.owner, 'b');
    check('fence monotonic', owned.fence, 2);
    check('new owner settles', (await cluster.snapshot()).capacity[0].data.active, 0);
    return { errors };
}
