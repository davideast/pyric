export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['intent is quarantined', 'capacity retained', 'no blind redispatch', 'admission remains blocked'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'uncertain' };
    const a = await cluster.spawn('a');
    const reserved = await a.command('reserve', request);
    await a.command('intent', request, { fence: reserved.record.fence });
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b');
    await b.command('takeover', request);
    const observed = await b.command('reconcile', request);
    const busy = await b.command('start', { uid: 'alice', requestId: 'replacement' });
    const state = await cluster.snapshot();
    check('intent is quarantined', observed.state, 'unknown');
    check('capacity retained', state.capacity[0].data.active, 1);
    check('no blind redispatch', provider.snapshot().jobs.length, 0);
    check('admission remains blocked', busy.status, 'busy');
    return { state: observed.state, finalActive: state.capacity[0].data.active };
}
