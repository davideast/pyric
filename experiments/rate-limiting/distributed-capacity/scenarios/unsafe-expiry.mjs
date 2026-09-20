export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['replacement admitted', 'old remote job survives', 'global bound', 'user bound'];
export const expectedFailures = ['global bound', 'user bound'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'unsafe-original' };
    const a = await cluster.spawn('a');
    await a.command('start', request);
    await cluster.kill('a'); cluster.advance(101);
    const b = await cluster.spawn('b');
    await b.command('unsafe-expire', request);
    const second = await b.command('start', { uid: 'alice', requestId: 'unsafe-replacement' });
    const oracle = provider.snapshot();
    check('replacement admitted', second.status, 'started');
    check('old remote job survives', oracle.jobs.filter(job => job.state === 'running').length, 2);
    check('global bound', oracle.peak <= 1, true, false);
    check('user bound', oracle.peakPerUser <= 1, true, false);
    return { peakRemote: oracle.peak, peakPerUser: oracle.peakPerUser };
}
