export const limits = { global: 2, perUser: 2, leaseMs: 100 };
export const checks = ['one start response', 'duplicate response', 'single provider operation', 'single capacity debit'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'same-request' };
    const workers = await Promise.all(['a', 'b'].map(owner => cluster.spawn(owner)));
    const responses = await Promise.all(workers.map(worker => worker.command('start', request)));
    check('one start response', responses.filter(row => row.status === 'started').length, 1);
    check('duplicate response', responses.filter(row => row.status === 'duplicate').length, 1);
    check('single provider operation', provider.snapshot().startAttempts, 1);
    check('single capacity debit', (await cluster.snapshot()).capacity[0].data.active, 1);
    return { providerStarts: provider.snapshot().startAttempts };
}
