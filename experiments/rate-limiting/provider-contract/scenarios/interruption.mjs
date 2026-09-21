export async function abortAfter(session, { chunk = false, deadline = false } = {}) {
    const started = await session.gateway.call('start', deadline ? { deadlineMs: 25 } : {});
    if (chunk) { await session.provider.call('control', { operation: 'chunk' }); await session.wait(() => session.observations.some(o => o.status === 'chunk')); }
    if (!deadline) await session.gateway.call('abort');
    const afterFault = await session.wait(s => s.reservation.requests[0].state === 'unknown');
    await session.provider.call('control', { operation: 'terminal', state: 'completed' });
    await session.gateway.call('observe', { providerOperationId: started.providerOperationId });
    const final = await session.wait(s => s.reservation.active === 0);
    return { trigger: deadline ? 'gateway-deadline' : chunk ? 'client-abort-after-chunk' : 'client-abort-after-acceptance', snapshots: { afterFault, final },
        retainedUntilObservation: afterFault.reservation.active === 1 && afterFault.oracle.running === 1, singleRelease: final.reservation.releases === 1 };
}
export async function stopRace(session, { completeFirst = false } = {}) {
    const { providerOperationId } = await session.gateway.call('start');
    if (completeFirst) {
        await session.provider.call('control', { operation: 'terminal', state: 'completed' });
        await session.wait(s => s.reservation.active === 0);
        await session.gateway.call('stop');
        await session.provider.call('control', { operation: 'terminal', state: 'cancelled' });
    } else {
        await session.gateway.call('stop');
        await session.provider.call('control', { operation: 'terminal', state: 'cancelled' });
        await session.wait(s => s.reservation.active === 0);
        await session.provider.call('control', { operation: 'terminal', state: 'completed' });
    }
    await session.gateway.call('observe', { providerOperationId });
    const final = await session.snapshot();
    return { snapshots: { final }, singleRelease: final.reservation.releases === 1,
        stableTerminal: final.reservation.requests[0].state === (completeFirst ? 'completed' : 'cancelled') };
}
export async function unavailableLookup(session) {
    const { providerOperationId } = await session.gateway.call('start');
    await session.provider.call('control', { operation: 'drop' });
    await session.wait(s => s.reservation.requests[0].state === 'unknown');
    const observed = await session.gateway.call('observe', { providerOperationId });
    const final = await session.snapshot();
    return { observed, snapshots: { final }, retainedUnknown: final.reservation.active === 1 && final.reservation.requests[0].state === 'unknown',
        unresolvedLookup: observed.status === 'unknown' };
}
