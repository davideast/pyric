export const executionChecks = [
    'execution capacity bound', 'reservations drain', 'provider operations settle',
    'slots held until provider settles', 'rejected executions avoid database',
    'execution retry rejected', 'execution recovery succeeds',
];
export function assessExecution(events, scenario, check) {
    const of = kind => events.filter(e => e.kind === kind);
    const active = of('provider-active');
    const slots = of('execution-reservation');
    const limits = scenario.executionLimit;
    check('execution capacity bound', active.every(e => e.value <= limits.perUid && e.instanceValue <= limits.instance), true,
        !scenario.negative?.includes('execution capacity bound'));
    check('reservations drain', slots.at(-1)?.instanceValue, 0);
    check('provider operations settle', of('provider-settled').length, of('inference-dispatch').length);
    check('slots held until provider settles', of('inference-dispatch').filter(dispatch => {
        const settled = of('provider-settled').find(e => e.attemptId === dispatch.attemptId && e.instanceId === dispatch.instanceId && e.localSequence > dispatch.localSequence);
        const release = slots.find(e => e.attemptId === dispatch.attemptId && e.instanceId === dispatch.instanceId && e.action === 'release' && e.localSequence > dispatch.localSequence);
        return !settled || !release || release.localSequence < settled.localSequence;
    }).length, 0);
    const rejected = new Set(of('request-response').filter(e => e.status === 'execution_busy').map(e => e.attemptId));
    check('rejected executions avoid database', of('transaction-attempt').filter(e => rejected.has(e.attemptId)).length, 0);
    const responses = of('client-response');
    if (scenario.checks.includes('execution instance saturation')) check('execution instance saturation', {
        completed: responses.filter(e => e.status === 'completed').length,
        rejected: responses.filter(e => e.status === 'execution_busy').length,
        peak: Math.max(0, ...slots.map(e => e.instanceValue)),
    }, {completed:2,rejected:4,peak:2});
    if (scenario.checks.includes('inference deadline observed')) check('inference deadline observed', responses.find(e => e.clientAttemptId === 'held')?.status, 'inference_timeout');
    if (scenario.checks.includes('execution retry rejected')) check('execution retry rejected', responses.find(e => e.clientAttemptId === 'retry')?.status, 'execution_busy');
    if (scenario.checks.includes('execution recovery succeeds')) check('execution recovery succeeds', responses.find(e => e.clientAttemptId === 'recovered')?.status, 'completed');
    if (scenario.checks.includes('execution normal users complete')) check('execution normal users complete', responses.filter(e => ['bob','carol'].includes(e.uid) && e.status === 'completed').length, 6);
    if (scenario.checks.includes('stream delivered before settlement')) {
        const chunks = of('client-chunk').filter(e => e.clientAttemptId === 'held');
        const settled = of('provider-settled').find(e => e.requestId === 'held');
        const emitted = of('provider-chunk').filter(e => e.requestId === 'held');
        const acknowledged = of('client-chunk-acknowledged').filter(e => e.clientAttemptId === 'held');
        const stream = scenario.schedule.find(e => e.id === 'held');
        let completeSequence = chunks.length === 1 && chunks[0].index === 0;
        if (!stream.disconnectOnChunk) completeSequence = JSON.stringify(chunks.map(e => e.index)) === JSON.stringify(Array.from({length:scenario.provider.chunks}, (_, i) => i));
        check('stream delivered before settlement', completeSequence && acknowledged.some(e => e.index === 0 && e.localSequence < settled?.localSequence)
            && emitted.length > 0 && emitted.every(e => e.localSequence < settled?.localSequence), true);
    }
    if (scenario.checks.includes('cancellation confirmed')) check('cancellation confirmed', of('provider-cancel-confirmed').filter(e => e.requestId === 'held').length, 1);
    if (scenario.checks.includes('cancellation ignored')) check('cancellation ignored', {
        requested: of('provider-cancel-requested').filter(e=>e.requestId==='held').length,
        confirmed: of('provider-cancel-confirmed').filter(e=>e.requestId==='held').length,
    }, { requested:1, confirmed:0 });
    if (scenario.checks.includes('provider failure does not redispatch')) check('provider failure does not redispatch', {
        dispatches:of('inference-dispatch').filter(e=>e.requestId==='held').length,
        failure:responses.find(e=>e.clientAttemptId==='held')?.status,
        repeat:responses.find(e=>e.clientAttemptId==='repeat')?.status,
    }, {dispatches:1,failure:'outcome_unknown',repeat:'duplicate'});
}
