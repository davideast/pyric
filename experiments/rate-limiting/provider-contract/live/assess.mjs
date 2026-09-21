import { caseIds } from './config.mjs';
export function assessLive(result) {
    const failures = [];
    if (result.run?.interrupted) failures.push('interrupted');
    if (result.cases?.length !== caseIds.length) failures.push('missing-cases');
    for (const id of caseIds) {
        const rows = (result.cases ?? []).filter(c => c.caseId === id);
        if (rows.length !== 1 || rows[0].status !== 'complete' || rows[0].expectedObserved !== true || !rows[0].snapshots?.after) failures.push(id + ':incomplete-or-inconclusive');
    }
    if (!Number.isInteger(result.finalBudget?.active) || !Number.isInteger(result.finalBudget?.dispatches)) failures.push('missing-final-budget');
    const limits = result.finalBudget?.limits;
    if (limits && (result.finalBudget.active > limits.maxConcurrent || result.finalBudget.dispatches > limits.maxDispatches)) failures.push('budget-exceeded');
    return { successfulExperiment: !failures.length, failures,
        remoteTerminationAfterAbort: 'unknown', safeRedispatchSupported: false,
        desiredRecoveryCapabilityAvailable: false, deploymentTested: false,
        cases: (result.cases ?? []).map(c => ({ caseId: c.caseId, status: c.status, dispatches: c.dispatches ?? null, remoteState: c.remoteState ?? 'unknown', finalMarkerAtAbort: c.finalMarkerAtAbort ?? null })),
        finalBudget: result.finalBudget ?? null };
}
