export async function normal(session, { streaming = false } = {}) {
    await session.gateway.call('start');
    if (streaming) {
        await session.provider.call('control', { operation: 'chunk' });
        await session.wait(() => session.observations.some(o => o.status === 'chunk'));
    }
    await session.provider.call('control', { operation: 'terminal', state: 'completed' });
    const final = await session.wait(s => s.reservation.active === 0);
    return { snapshots: { final }, singleRelease: final.reservation.releases === 1, completed: final.reservation.requests[0].state === 'completed',
        usageObserved: session.observations.some(o => o.usage?.totalTokenCount === 3) };
}
export async function abortBefore(session) {
    await session.gateway.call('start', { abortBefore: true });
    const final = await session.snapshot();
    return { snapshots: { final }, zeroDispatch: final.reservation.dispatches === 0 && final.oracle.attempts === 0, noReservation: final.reservation.active === 0 };
}
export async function duplicateKey(session) {
    await session.gateway.call('start', { key: 'shared-key' });
    const duplicate = await session.gateway.call('start', { requestId: 'request-two', key: 'shared-key' });
    const during = await session.snapshot();
    await session.provider.call('control', { operation: 'terminal', state: 'completed' });
    const final = await session.wait(s => s.reservation.active === 0);
    return { duplicate, snapshots: { during, final }, oneProviderOperation: final.oracle.jobs.length === 1,
        twoChargedDispatches: final.reservation.dispatches === 2 && final.oracle.attempts === 2, eachReservationReleasedOnce: final.reservation.releases === 2 };
}
