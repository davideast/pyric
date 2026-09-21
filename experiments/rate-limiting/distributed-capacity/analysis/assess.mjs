import { isDeepStrictEqual } from 'node:util';
import { coverageIssues, compareEvidence } from '../../../shared/evidence/compare.mjs';
import { scenarios } from '../harness/scenarios.mjs';
export function assess(result) {
    const ids = result.run.selectedCases ?? [];
    const issues = [];
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !scenarios[id])) issues.push('Invalid scenario selection');
    const required = Object.fromEntries(ids.filter(id => scenarios[id]).map(id => [id, scenarios[id].checks]));
    issues.push(...coverageIssues(result, required));
    for (const row of result.assertions) {
        const scenario = scenarios[row.caseId];
        if (!scenario || !ids.includes(row.caseId) || !scenario.checks.includes(row.name)) { issues.push('Unknown assertion'); continue; }
        const expectedPass = !(scenario.expectedFailures ?? []).includes(row.name);
        if (row.expectedPass !== expectedPass || row.passed !== isDeepStrictEqual(row.actual, row.expected)) issues.push(`Inconsistent assertion: ${row.caseId}/${row.name}`);
        if (row.passed !== expectedPass) issues.push(`Unexpected outcome: ${row.caseId}/${row.name}`);
    }
    if (result.cases.length !== ids.length) issues.push('Extra or missing case');
    return { successfulExperiment: issues.length === 0, issues, cases: result.cases.length, assertions: result.assertions.length,
        expectedControlFailures: result.assertions.filter(row => !row.passed && row.expectedPass === false).length,
        productionValidated: false };
}
export function compare(left, right) {
    const required = Object.fromEntries((left.run.selectedCases ?? []).filter(id => scenarios[id]).map(id => [id, scenarios[id].checks]));
    const comparison = compareEvidence(left, right, required);
    if (!isDeepStrictEqual(left.run.selectedCases, right.run.selectedCases)) comparison.mismatches.push('selected cases');
    if (!assess(left).successfulExperiment || !assess(right).successfulExperiment) comparison.mismatches.push('assessment failed');
    comparison.compatible = comparison.mismatches.length === 0;
    if (!comparison.compatible) comparison.decisions = [];
    return comparison;
}
export function summarize(result) {
    return { assessment: assess(result), cases: Object.fromEntries(result.cases.map(row => {
        const events = result.events.filter(event => event.caseId === row.id);
        const attempts = events.filter(event => event.kind === 'transaction-attempt');
        return [row.id, { status: row.status, observations: row.observations ?? null,
            peakRemote: row.oracle?.peak ?? null, peakPerUser: row.oracle?.peakPerUser ?? null,
            finalActive: row.state?.capacity?.find(item => item.id === 'global')?.data.active ?? null,
            transactionAttempts: attempts.length, transactionInvocations: new Set(attempts.map(event => event.invocationId)).size,
            killedGateways: events.filter(event => event.kind === 'fault-gateway-kill').length }];
    })), limitations: result.run.environment.limitations };
}
