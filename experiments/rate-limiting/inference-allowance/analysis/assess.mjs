import { lifecycleScenarios } from '../scenarios/provider-lifecycle.mjs';
import { scenarios as directScenarios } from '../harness/runner.mjs';
import { httpScenarios } from '../scenarios/http-overload.mjs';
const scenarios = { ...directScenarios, ...httpScenarios, ...lifecycleScenarios };
export function assessRun(result) {
    const issues = [];
    const selected = result.run.selectedCases;
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length)
        issues.push('Missing or duplicate requested coverage');
    for (const id of selected ?? []) {
        const spec = scenarios[id];
        if (!spec) {
            issues.push(`Unknown case ${id}`);
            continue;
        }
        if (result.cases.filter(c => c.id === id && c.status === 'complete').length !== 1)
            issues.push(`${id}: incomplete case`);
        for (const name of spec.checks) {
            const rows = result.assertions.filter(a => a.caseId === id && a.name === name);
            if (rows.length !== 1 || rows[0].passed !== !(spec.negative ?? []).includes(name))
                issues.push(`${id}: ${name}`);
        }
    }
    if (result.cases.length !== (selected ?? []).length || result.cases.some(c => !selected?.includes(c.id)))
        issues.push('Unexpected case coverage');
    for (const a of result.assertions)
        if (!selected?.includes(a.caseId) || !scenarios[a.caseId]?.checks.includes(a.name))
            issues.push('Unexpected assertion');
    return { successfulExperiment: issues.length === 0, issues, expectedNegativeControls: result.assertions.filter(a => !a.passed && scenarios[a.caseId]?.negative?.includes(a.name)).length };
}
export function compareRuns(left, right) {
    const mismatches = [];
    for (const field of ['workloadHash', 'implementationHash', 'rulesHash'])
        if (!left.run[field] || left.run[field] !== right.run[field])
            mismatches.push(field);
    if (left.schemaVersion !== right.schemaVersion)
        mismatches.push('schemaVersion');
    if (JSON.stringify(left.run.selectedCases) !== JSON.stringify(right.run.selectedCases))
        mismatches.push('selectedCases');
    // Unexpected decisions remain comparable; incomplete/missing coverage does not.
    const coverage = r => {
        const selected = r.run.selectedCases;
        if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || r.cases.length !== selected.length)
            return false;
        if (!selected.every(id => scenarios[id] && r.cases.filter(c => c.id === id && c.status === 'complete').length === 1))
            return false;
        const expected = selected.flatMap(id => scenarios[id].checks.map(name => [id, name]));
        return r.assertions.length === expected.length && expected.every(([id, name]) => r.assertions.filter(a => a.caseId === id && a.name === name).length === 1);
    };
    if (!coverage(left) || !coverage(right))
        mismatches.push('incomplete coverage');
    const cohort = r => ({ runId: r.run.id, environment: r.run.environment,
        contention: r.events.filter(e => e.kind === 'contention-observation'),
        responses: r.events.filter(e => e.kind === 'request-response').reduce((counts, e) => {
            const key = `${e.caseId}/${e.uid ?? 'signed-out'}/${e.status}`;
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
        }, {}) });
    return { compatible: !mismatches.length, mismatches, performanceComparable: false,
        cohorts: { left: cohort(left), right: cohort(right) },
        decisions: mismatches.length ? [] : left.assertions.map(a => {
            const other = right.assertions.find(b => b.caseId === a.caseId && b.name === a.name);
            return { caseId: a.caseId, name: a.name, left: a.passed, right: other.passed, leftActual: a.actual, rightActual: other.actual };
        }) };
}
