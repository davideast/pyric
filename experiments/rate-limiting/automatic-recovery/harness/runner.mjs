import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRecoveryCluster } from '../adapters/pyric-cluster.mjs';
import { scenarios } from '../scenarios/registry.mjs';
import { pyricBackend } from '../../../shared/backends/pyric.mjs';
import { POLICIES, LIMITS, RECOVERY_BUDGET } from '../fixtures/contracts.mjs';

export async function runCases(ids = Object.keys(scenarios), onEvent = () => {}, runId = randomUUID()) {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !scenarios[id]))
        throw new Error('Unknown or duplicate case ID');

    const result = {
        schemaVersion: 1,
        run: {
            id:            runId,
            selectedCases: ids,
            startedAt:     new Date().toISOString(),
            budget:        RECOVERY_BUDGET,
            environment: {
                ...pyricBackend.environment,
                transport:     'separate Node gateway + recovery worker processes; IPC to shared Pyric sandbox',
                clock:         'logical milliseconds with per-process clock skew support',
                authorization: 'trusted synthetic gateway & recovery worker owners; Admin sandbox bypasses client Rules',
                production:    false,
                realInference: false,
                limitations: [
                    'No hosted Cloud Run kill or network partition in local profile',
                    'Provider status and activity are controlled by an independent host fixture oracle',
                ],
            },
        },
        cases:      [],
        events:     [],
        assertions: [],
    };

    for (const id of ids) {
        const record = (kind, data = {}) => {
            const event = { ...data, kind, caseId: id, runId: result.run.id, sequence: result.events.length, timestamp: new Date().toISOString() };
            result.events.push(event);
            onEvent(event);
        };

        const scenario = scenarios[id];
        const check = (name, actual, expected) => {
            const expectedPass = !(scenario.expectedFailures ?? []).includes(name);
            result.assertions.push({
                runId: result.run.id,
                caseId: id,
                name,
                actual,
                expected,
                passed: isDeepStrictEqual(actual, expected),
                expectedPass,
            });
        };

        const cluster = await createRecoveryCluster({
            record,
            limits: LIMITS,
            policies: POLICIES,
            budget: RECOVERY_BUDGET,
            runId,
            caseId: id,
        });

        try {
            const observations = await scenario.run({ cluster, check, record });
            result.cases.push({
                id,
                status:          'complete',
                contractLimited: Boolean(scenario.contractLimited),
                observations,
                state:           await cluster.snapshot(),
                oracle:          cluster.provider.snapshot(),
            });
        } catch (error) {
            result.cases.push({
                id,
                status: 'incomplete',
                error:  error.message,
                state:  await cluster.snapshot(),
                oracle: cluster.provider.snapshot(),
            });
        } finally {
            await cluster.close();
        }
    }

    result.run.finishedAt = new Date().toISOString();
    return result;
}
