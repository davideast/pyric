export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['confirmed cancelled state', 'released after cancellation', 'no remote work remains'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'cancelled' };
    const a = await cluster.spawn('a');
    const started = await a.command('start', request);
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b'); await b.command('takeover', request);
    provider.finish(started.record.providerKey, 'cancelled');
    const observed = await b.command('reconcile', request);
    const active = (await cluster.snapshot()).capacity[0].data.active;
    check('confirmed cancelled state', observed.state, 'cancelled');
    check('released after cancellation', active, 0);
    check('no remote work remains', provider.snapshot().jobs.filter(job => job.state === 'running').length, 0);
    return { finalActive: active };
}
