import { scenarios } from '../scenarios/registry.mjs';
export function assess(result) {
    const ids = result.run?.selectedCases ?? [];
    const failures = [];
    if (!ids.length || new Set(ids).size !== ids.length || result.run?.interrupted) failures.push('incomplete-run');
    if (result.cases?.length !== ids.length) failures.push('case-count');
    let expectedCount = 0;
    for (const id of ids) {
        const spec = scenarios[id]; const rows = (result.cases ?? []).filter(c => c.caseId === id);
        if (!spec || rows.length !== 1 || rows[0].status !== 'complete') { failures.push(id + ':incomplete'); continue; }
        for (const [name, expected] of Object.entries(spec.expected)) {
            expectedCount++;
            const checks = (result.assertions ?? []).filter(a => a.caseId === id && a.name === name);
            if (checks.length !== 1 || checks[0].actual !== expected || checks[0].expected !== expected || rows[0][name] !== expected) failures.push(id + ':' + name);
        }
    }
    if (result.assertions?.length !== expectedCount) failures.push('assertion-count');
    return { successfulExperiment: failures.length === 0, failures, checks: expectedCount,
        expectedUnsafeControl: ids.includes('unsafe-transport-release'), productionConclusion: false };
}
export function summarize(result) {
    const observations = (result.events ?? []).filter(e => e.kind === 'provider-observation');
    const count = status => observations.filter(e => e.status === status).length;
    return { ...assess(result), runId: result.run?.id, metrics: { commands: result.run?.commands ?? null,
        dispatchCharges: (result.cases ?? []).reduce((n, c) => n + (c.snapshots?.final?.reservation.dispatches ?? 0), 0),
        providerAttempts: (result.cases ?? []).reduce((n, c) => n + (c.snapshots?.final?.oracle.attempts ?? 0), 0),
        stopAcknowledgments: count('acknowledged'), cancellationObservations: count('cancelled'),
        completionObservations: count('completed'), unsupportedObservations: count('unsupported'),
        unresolvedReservationsAtCaseEnd: (result.cases ?? []).reduce((n, c) => n + (c.snapshots?.final?.reservation.active ?? 0), 0),
        observationCountsAreNotUniqueJobs: true, usageWhenNotReturned: null }, cases: (result.cases ?? []).map(c => ({ caseId: c.caseId, status: c.status,
        assertions: (result.assertions ?? []).filter(a => a.caseId === c.caseId), final: c.snapshots?.final ?? null })) };
}
export function compare(left, right) {
    const differences = ['workloadHash', 'rulesHash', 'implementationHash'].filter(k => !left.run?.[k] || left.run[k] !== right.run?.[k]);
    if (!assess(left).successfulExperiment || !assess(right).successfulExperiment) differences.push('incomplete-or-unexpected-outcome');
    if (left.run?.environment?.builtPackageHash !== right.run?.environment?.builtPackageHash) differences.push('backend-build');
    return { compatible: differences.length === 0, differences, scope: 'Matching controlled workload and code; timings are not production performance predictions' };
}
