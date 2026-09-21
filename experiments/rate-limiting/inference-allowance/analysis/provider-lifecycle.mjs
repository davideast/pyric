export const lifecycleChecks = [
    'lifecycle responses', 'one dispatch per request', 'capacity retained until termination', 'execution capacity respected',
    'remote work respects capacity', 'unknown outcomes retain capacity', 'cancellation evidence', 'pre-dispatch stops',
    'stream evidence', 'busy requests avoid database', 'saved debits are not refunded', 'complete lifecycle evidence',
];
export function assessLifecycle(events, scenario, check) {
    const of = kind => events.filter(e => e.kind === kind);
    const assert = (name, actual, expected) => check(name, actual, expected, !scenario.negative?.includes(name));
    const dispatched = of('inference-dispatch');
    const slots = of('execution-reservation');
    assert('lifecycle responses', {
        replies: Object.fromEntries(of('client-response').map(e => [e.clientAttemptId, e.status])),
        disconnected: of('client-disconnected').map(e => e.clientAttemptId),
    }, { replies: scenario.expected, disconnected: scenario.disconnected ?? [] });
    const keys = dispatched.map(e => JSON.stringify([e.uid, e.requestId]));
    assert('one dispatch per request', keys.length, new Set(keys).size);
    const releases = slots.filter(e => e.action === 'release' && dispatched.some(d => d.attemptId === e.attemptId));
    assert('capacity retained until termination', releases.every(release => of('provider-settled').some(e => e.attemptId === release.attemptId && e.localSequence < release.localSequence)), true);
    const bounded = list => list.every(e => e.value <= scenario.options.maxExecutionPerUid && e.instanceValue <= scenario.options.maxExecution && e.value >= 0 && e.instanceValue >= 0);
    assert('execution capacity respected', bounded(slots), true);
    assert('remote work respects capacity', bounded(of('fixture-remote-active')), true);
    assert('unknown outcomes retain capacity', {
        unknown: of('provider-outcome').filter(e => e.outcome === 'unknown').map(e => e.requestId),
        quarantined: of('execution-quarantined').map(e => e.requestId),
        finalReserved: slots.at(-1)?.instanceValue,
    }, { unknown: scenario.unknown ?? [], quarantined: scenario.unknown ?? [], finalReserved: scenario.unknown?.length ?? 0 });
    const cancellation = { requested: of('provider-cancel-requested').length, confirmed: of('provider-cancel-confirmed').length };
    assert('cancellation evidence', cancellation, scenario.cancellation ?? { requested: 0, confirmed: 0 });
    assert('pre-dispatch stops', dispatched.filter(e => scenario.noDispatch?.includes(e.requestId)).length, 0);
    const chunks = of('client-chunk').filter(e => e.clientAttemptId === 'held');
    const transport = of('transport-ended').find(e => e.requestId === 'held');
    let firstChunkObserved = true;
    if (chunks.length && scenario.disconnected?.includes('held')) {
        const disconnect = of('client-disconnected').find(e => e.clientAttemptId === 'held');
        const emitted = of('provider-chunk').find(e => e.requestId === 'held' && e.index === 0);
        firstChunkObserved = chunks[0].localSequence < disconnect?.localSequence && emitted?.localSequence < transport?.localSequence;
    } else if (chunks.length) {
        firstChunkObserved = of('client-chunk-acknowledged').some(e => e.clientAttemptId === 'held' && e.index === 0 && e.localSequence < transport?.localSequence);
    }
    assert('stream evidence', { chunks: chunks.map(e => e.index), firstChunkObserved },
        { chunks: scenario.chunks ?? [], firstChunkObserved: true });
    const busy = new Set(of('request-response').filter(e => e.status === 'execution_busy').map(e => e.attemptId));
    assert('busy requests avoid database', of('transaction-attempt').filter(e => busy.has(e.attemptId)).length, 0);
    // Controlled admission clock does not advance, so exactly one credit per
    // admitted receipt must remain debited even if output is cancelled or lost.
    assert('saved debits are not refunded', of('stored-allowance').every(e => {
        const receipts = e.receipts.filter(row => row.receipt);
        return (e.quota?.buckets.chat.remaining ?? 300000) === 300000 - receipts.length * 60000
            && receipts.every(row => row.receipt.state === 'dispatching')
            && receipts.length === dispatched.filter(d => d.uid === e.uid).length;
    }), true);
    const server = events.filter(e => e.role === 'server');
    assert('complete lifecycle evidence', server.length > 0 && server.every((e, i) => e.localSequence === i)
        && of('fixture-remote-finished').length === dispatched.length
        && of('stored-allowance').length === new Set(scenario.schedule.filter(e => e.operation !== 'cancel').map(e => e.uid)).size
        && of('transport-ended').length + of('transport-pending').length === dispatched.length
        && (scenario.legacyTransportControl || of('provider-outcome').length === dispatched.length)
        && of('server-drained').length === 1, true);
}

export function summarizeLifecycle(result) {
    return Object.fromEntries(result.run.selectedCases.map(caseId => {
        const events = result.events.filter(e => e.caseId === caseId);
        const of = kind => events.filter(e => e.kind === kind);
        const outcomes = of('provider-outcome');
        const dispatches = of('inference-dispatch');
        const remoteActivity = of('fixture-remote-active');
        let peakRemotePerUser = null;
        if (remoteActivity.length) peakRemotePerUser = Math.max(...remoteActivity.map(e => e.value));
        return [caseId, {
            inferenceRequests: of('request-start').length, cancellationRequests: of('cancellation-response').length,
            dispatches: dispatches.length,
            completed: outcomes.filter(e => e.outcome === 'completed').length,
            cancelled: outcomes.filter(e => e.outcome === 'cancelled').length,
            unknown: outcomes.filter(e => e.outcome === 'unknown').length,
            quarantined: of('execution-quarantined').length,
            peakRemotePerUser,
            finalReserved: of('execution-reservation').at(-1)?.instanceValue ?? null,
            cancellationConfirmations: of('provider-cancel-confirmed').length,
            operations: dispatches.map(d => {
                const one = kind => of(kind).find(e => e.attemptId === d.attemptId && e.instanceId === d.instanceId);
                const release = of('execution-reservation').find(e => e.attemptId === d.attemptId && e.action === 'release');
                const ended = one('transport-ended');
                const outcome = one('provider-outcome');
                return { uid: d.uid, requestId: d.requestId, attemptId: d.attemptId, instanceId: d.instanceId,
                    outcome: outcome?.outcome ?? 'unclassified-legacy-control', evidence: outcome?.evidence ?? null,
                    transportMs: ended ? ended.localElapsedMs - d.localElapsedMs : null,
                    remoteTerminationMs: one('provider-settled') ? one('provider-settled').localElapsedMs - d.localElapsedMs : null,
                    releaseAfterTransportMs: release && ended ? release.localElapsedMs - ended.localElapsedMs : null,
                    // This oracle is available only in a simulation, never filled in from transport events.
                    fixtureRemoteMs: one('fixture-remote-finished') ? one('fixture-remote-finished').localElapsedMs - d.localElapsedMs : null };
            }),
        }];
    }));
}
