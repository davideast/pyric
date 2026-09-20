export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['unknown retained', 'oracle still running', 'capacity still occupied', 'confirmation permits release'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'hidden-provider' };
    const a = await cluster.spawn('a');
    const started = await a.command('start', request);
    provider.hide(started.record.providerKey);
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b'); await b.command('takeover', request);
    const unknown = await b.command('reconcile', request);
    const unknownActive = (await cluster.snapshot()).capacity[0].data.active;
    check('unknown retained', unknown.state, 'unknown');
    check('oracle still running', provider.snapshot().jobs[0].state, 'running');
    check('capacity still occupied', unknownActive, 1);
    provider.finish(started.record.providerKey); provider.reveal(started.record.providerKey);
    await b.command('reconcile', request);
    check('confirmation permits release', (await cluster.snapshot()).capacity[0].data.active, 0);
    return { unknownActive };
}
