import { randomUUID }    from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCluster } from './cluster.mjs';
import { scenarios }     from '../scenarios/registry.mjs';
import { pyricBackend }  from '../../../shared/backends/pyric.mjs';
import { POLICIES, LIMITS } from '../fixtures/policy.mjs';

/**
 * Run selected cases against a fresh Pyric sandbox cluster.
 * Each case gets an isolated cluster (fresh Pyric state).
 *
 * @param {string[]} ids   - Case IDs to run
 * @param {(event: object) => void} onEvent
 * @param {string} runId
 */
export async function runCases(ids = Object.keys(scenarios), onEvent = () => {}, runId = randomUUID()) {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !scenarios[id]))
        throw new Error('Unknown or duplicate case ID');

    const result = {
        schemaVersion: 1,
        run: {
            id:            runId,
            selectedCases: ids,
            startedAt:     new Date().toISOString(),
            environment: {
                ...pyricBackend.environment,
                transport:     'separate Node gateway processes; IPC to shared in-process Pyric sandbox',
                clock:         'logical milliseconds; advanced at barriers per scenario',
                authorization: 'trusted synthetic gateway owners; Admin sandbox bypasses client Rules',
                production:    false,
                realInference: false,
                limitations: [
                    'No hosted Firestore measurement or pessimistic-locking/throughput claim',
                    'Provider status and activity are a controlled fixture, not real AI Logic',
                    'No autoscaling, clock-skew, or automatic reaper validated',
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
            result.assertions.push({ runId: result.run.id, caseId: id, name, actual, expected, passed: isDeepStrictEqual(actual, expected), expectedPass });
        };
        const cluster  = await createCluster({ record, limits: LIMITS, policies: POLICIES, runId, caseId: id });

        try {
            const observations = await scenario.run({ cluster, check, record });
            result.cases.push({
                id,
                status:       'complete',
                observations,
                state:        await cluster.snapshot(),
                oracle:       cluster.provider.snapshot(),
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
