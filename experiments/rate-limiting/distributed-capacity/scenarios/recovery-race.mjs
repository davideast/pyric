export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['one recovery owner', 'loser observes live lease', 'single fence increment', 'capacity retained'];
export async function run({ cluster, check }) {
    const request = { uid: 'alice', requestId: 'recovery-race' };
    const a = await cluster.spawn('a'); await a.command('reserve', request);
    await cluster.kill('a'); cluster.advance(101);
    const workers = await Promise.all(['b', 'c'].map(owner => cluster.spawn(owner)));
    const results = await Promise.allSettled(workers.map(worker => worker.command('takeover', request)));
    const winners = results.filter(row => row.status === 'fulfilled').length;
    const errors = results.filter(row => row.status === 'rejected').map(row => row.reason.message);
    const state = await cluster.snapshot();
    check('one recovery owner', winners, 1);
    check('loser observes live lease', errors, ['lease-owned']);
    check('single fence increment', state.requests[0].data.fence, 2);
    check('capacity retained', state.capacity[0].data.active, 1);
    return { winners };
}
