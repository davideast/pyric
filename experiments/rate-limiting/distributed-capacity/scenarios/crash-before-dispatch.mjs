export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['fence advanced', 'single provider operation', 'released after completion', 'one reservation'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'before-dispatch' };
    const a = await cluster.spawn('a');
    await a.command('reserve', request);
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b');
    const record = await b.command('takeover', request);
    await b.command('resume', request);
    provider.finish(record.providerKey);
    await b.command('reconcile', request);
    const state = await cluster.snapshot();
    const observations = { recoveredFence: record.fence, providerStarts: provider.snapshot().startAttempts, finalActive: state.capacity[0].data.active };
    check('fence advanced', record.fence, 2);
    check('single provider operation', observations.providerStarts, 1);
    check('released after completion', observations.finalActive, 0);
    check('one reservation', state.requests.length, 1);
    return observations;
}
