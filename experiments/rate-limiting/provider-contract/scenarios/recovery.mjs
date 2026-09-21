export async function explicitStop(session) {
    await session.gateway.call('start');
    const forgedStop = await session.gateway.call('stop', { uid: 'outsider' });
    const acknowledgment = await session.gateway.call('stop');
    const afterFault = await session.snapshot();
    await session.provider.call('control', { operation: 'terminal', state: 'cancelled' });
    const final = await session.wait(s => s.reservation.active === 0);
    return { forgedStop, acknowledgment, snapshots: { afterFault, final }, acknowledgmentHeldCapacity: afterFault.reservation.active === 1,
        ownerEnforced: forgedStop.status === 'denied' && afterFault.oracle.stops === 1, singleRelease: final.reservation.releases === 1 };
}
export async function lostGateway(session) {
    await session.gateway.call('start');
    await session.gateway.kill();
    const afterFault = await session.snapshot();
    const replacement = await session.spawnGateway();
    // Only a durable record's provider ID is passed to the replacement. No oracle
    // state is given to it, and no start command is issued during reconciliation.
    const providerOperationId = afterFault.reservation.requests[0].providerOperationId;
    await replacement.call('observe', { providerOperationId });
    const duringRecovery = await session.snapshot();
    await session.provider.call('control', { operation: 'terminal', state: 'completed' });
    await replacement.call('observe', { providerOperationId });
    const final = await session.wait(s => s.reservation.active === 0);
    return { replacementProcessId: replacement.pid, snapshots: { afterFault, duringRecovery, final },
        restartHeldCapacity: duringRecovery.reservation.active === 1 && duringRecovery.oracle.running === 1,
        noRedispatch: final.oracle.attempts === 1, singleRelease: final.reservation.releases === 1 };
}
