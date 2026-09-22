import { scenarios } from '../scenarios/registry.mjs';

export async function runAllScenarios({ caseIds = Object.keys(scenarios) } = {}) {
    const cases = [];
    const assertions = [];
    const events = [];

    for (const id of caseIds) {
        const spec = scenarios[id];
        if (!spec) throw new Error(`Unknown scenario: ${id}`);

        const caseAssertions = [];
        const expectedFailures = new Set(spec.expectedFailures ?? []);

        const check = (name, actual, expected) => {
            const passed = JSON.stringify(actual) === JSON.stringify(expected);
            const expectedFailure = expectedFailures.has(name);
            const row = {
                caseId: id,
                name,
                passed,
                expectedFailure,
                effectivePass: expectedFailure ? !passed : passed,
                actual,
                expected,
            };
            assertions.push(row);
            caseAssertions.push(row);
        };

        try {
            const output = await spec.run({ check });
            cases.push({
                id,
                status: 'completed',
                passed: caseAssertions.every(a => a.effectivePass),
                assertions: caseAssertions,
                output,
            });
            events.push({ kind: 'case-completed', caseId: id, assertions: caseAssertions.length });
        } catch (error) {
            cases.push({
                id,
                status: 'incomplete',
                error: error.code ?? error.message,
                assertions: caseAssertions,
            });
            events.push({ kind: 'case-error', caseId: id, error: error.code ?? error.message });
        }
    }

    return { cases, assertions, events };
}
