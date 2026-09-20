export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['client lost acknowledgement', 'retry finds reservation', 'one durable reservation', 'one capacity debit', 'no inference before recovery'];
export async function run({ cluster, provider, check }) {
    const request = { uid: 'alice', requestId: 'lost-ack' };
    const a = await cluster.spawn('a');
    let armed = true;
    cluster.setFault(async (phase, meta) => {
        if (armed && phase === 'afterCommit' && meta.instanceId === 'a') {
            armed = false; await cluster.kill('a'); throw new Error('injected-ack-loss');
        }
    });
    let clientError = 'none';
    try { await a.command('reserve', request); } catch (error) { clientError = error.message; }
    const b = await cluster.spawn('b');
    const retry = await b.command('start', request);
    const state = await cluster.snapshot();
    check('client lost acknowledgement', clientError, 'gateway-exited');
    check('retry finds reservation', retry.status, 'duplicate');
    check('one durable reservation', state.requests.length, 1);
    check('one capacity debit', state.capacity[0].data.active, 1);
    check('no inference before recovery', provider.snapshot().jobs.length, 0);
    return { retryStatus: retry.status, finalActive: state.capacity[0].data.active };
}
