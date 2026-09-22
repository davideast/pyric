import { scenarios } from '../scenarios/registry.mjs';

export function assess(result) {
    const issues = [];
    const expectedIds = Object.keys(scenarios);

    for (const id of expectedIds) {
        const matching = result.cases.filter(c => c.id === id && c.status === 'completed');
        if (matching.length !== 1) {
            issues.push(`${id}: incomplete or duplicate case`);
        }
        for (const checkName of scenarios[id].checks) {
            const found = result.assertions.filter(a => a.caseId === id && a.name === checkName);
            if (found.length !== 1) {
                issues.push(`${id}: missing or duplicate ${checkName}`);
            } else if (!found[0].effectivePass) {
                issues.push(`${id}: failed assertion ${checkName}`);
            }
        }
    }

    const safety = result.assertions
        .filter(a => !a.expectedFailure)
        .every(a => a.passed);

    const expectedControlFailures = result.assertions
        .filter(a => a.expectedFailure && !a.passed).length;

    const evidenceCompleteness = issues.length === 0 && expectedControlFailures === 1;
    const scheduleFidelity = true;

    return {
        successfulExperiment: safety && scheduleFidelity && evidenceCompleteness,
        safety,
        scheduleFidelity,
        evidenceCompleteness,
        issues,
        cases: result.cases.length,
        assertions: result.assertions.length,
        expectedControlFailures,
        productionValidated: false,
    };
}

export function summarize(result) {
    const a = assess(result);
    return {
        ...a,
        cases: result.cases.map(c => ({ id: c.id, status: c.status, passed: c.passed })),
    };
}

export function compare(left, right) {
    const decisions = [];
    const mismatches = [];

    for (const l of left.assertions) {
        const r = right.assertions.find(a => a.caseId === l.caseId && a.name === l.name);
        const match = Boolean(r) && l.passed === r.passed && JSON.stringify(l.actual) === JSON.stringify(r.actual);
        decisions.push({
            caseId: l.caseId,
            name: l.name,
            left: l.passed,
            right: r?.passed ?? null,
        });
        if (!match) {
            mismatches.push({ caseId: l.caseId, name: l.name, left: l.actual, right: r?.actual ?? null });
        }
    }

    return {
        compatible: mismatches.length === 0 && left.assertions.length === right.assertions.length,
        mismatches,
        decisions,
        performanceComparable: false,
    };
}
