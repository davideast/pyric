export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['renewal extends lease', 'early takeover rejected', 'original owner retained'];
export async function run({ cluster, check }) {
    const request = { uid: 'alice', requestId: 'renewal' };
    const a = await cluster.spawn('a'), b = await cluster.spawn('b');
    await a.command('reserve', request);
    cluster.advance(90); const renewed = await a.command('renew', request, { fence: 1 });
    cluster.advance(11);
    let takeoverError = 'allowed';
    try { await b.command('takeover', request); } catch (error) { takeoverError = error.message; }
    check('renewal extends lease', renewed.leaseUntil, 1190);
    check('early takeover rejected', takeoverError, 'lease-owned');
    check('original owner retained', (await cluster.snapshot()).requests[0].data.owner, 'a');
    return { takeoverError };
}
