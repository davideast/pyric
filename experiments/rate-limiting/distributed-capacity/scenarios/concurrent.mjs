export const limits = { global: 3, perUser: 2, leaseMs: 100 };
export const checks = ['three admissions', 'global bound', 'user bound', 'counters match reservations'];
export async function run({ cluster, provider, check }) {
    const workers = await Promise.all(['a', 'b', 'c'].map(owner => cluster.spawn(owner)));
    const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => workers[i % 3].command('start', { uid: i % 2 ? 'alice' : 'bob', requestId: `request-${i}` })));
    const oracle = provider.snapshot(), state = await cluster.snapshot();
    const observations = { admitted: responses.filter(row => row.status === 'started').length, peakRemote: oracle.peak, peakPerUser: oracle.peakPerUser };
    check('three admissions', observations.admitted, 3);
    check('global bound', oracle.peak <= 3, true);
    check('user bound', oracle.peakPerUser <= 2, true);
    check('counters match reservations', state.capacity[0].data.active, state.requests.length);
    return observations;
}
