import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export function createRecorder(environment, id = randomUUID(), onEvent = () => { }) {
    const result = { schemaVersion: 2, run: { id, startedAt: new Date().toISOString(), environment }, cases: [], events: [], assertions: [], inferences: [] };
    return { result, forCase(caseId) {
            return {
                record(kind, data = {}) {
                    const event = { ...data, id: randomUUID(), runId: id, caseId, sequence: result.events.length, elapsedMs: performance.now(), kind };
                    result.events.push(event);
                    if (kind === 'inference-dispatch')
                        result.inferences.push(event);
                    onEvent(event);
                    return event.id;
                },
                assert(name, actual, expected, expectedPass = true) {
                    result.assertions.push({ runId: id, caseId, name, actual, expected, expectedPass, passed: isDeepStrictEqual(actual, expected), evidenceThroughSequence: result.events.length - 1 });
                },
            };
        } };
}
