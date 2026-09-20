export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['orphan remains running', 'orphan blocks admission', 'completion recovers capacity', 'no overlapping remote jobs'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'during-inference' };
    const a = await cluster.spawn('a');
    const started = await a.command('start', request);
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b');
    await b.command('takeover', request);
    const observed = await b.command('reconcile', request);
    const busy = await b.command('start', { uid: 'bob', requestId: 'next' });
    check('orphan remains running', observed.state, 'running');
    check('orphan blocks admission', busy.status, 'busy');
    provider.finish(started.record.providerKey);
    await b.command('reconcile', request);
    const admitted = await b.command('start', { uid: 'bob', requestId: 'next' });
    check('completion recovers capacity', admitted.status, 'started');
    check('no overlapping remote jobs', provider.snapshot().peak, 1);
    return { busyWhileOrphaned: busy.status, recoveredAdmission: admitted.status };
}
