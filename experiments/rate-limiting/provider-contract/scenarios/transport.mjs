export async function transportLoss(session) {
    const { providerOperationId } = await session.gateway.call('start');
    await session.provider.call('control', { operation: 'drop' });
    const afterFault = await session.wait(s => s.reservation.requests[0]?.state === 'unknown');
    await session.provider.call('control', { operation: 'terminal', state: 'completed' });
    await session.gateway.call('observe', { providerOperationId });
    const final = await session.wait(s => s.reservation.active === 0);
    return { snapshots: { afterFault, final }, capacityBoundRespected: afterFault.oracle.running <= afterFault.reservation.active };
}
export async function unresolved(session) {
    await session.gateway.call('start');
    await session.provider.call('control', { operation: 'drop' });
    const afterFault = await session.wait(s => s.reservation.requests[0]?.state === 'unknown');
    const stop = await session.gateway.call('stop');
    await session.gateway.call('observe', { providerOperationId: null });
    const secondStart = await session.gateway.call('start', { requestId: 'request-two', uid: 'alice' });
    const final = await session.snapshot();
    return { snapshots: { afterFault, final }, secondStart, unsupportedStop: stop.status === 'unsupported', capacityBoundRespected: final.oracle.running <= 1 };
}
