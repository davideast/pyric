// Preserve provider entry structure for approved telemetry; do not export
// arbitrary application payloads, document bodies, credentials or caller IPs.
// Version this allowlist when adding a new diagnostic field.
export const redactionVersion = 1;
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const telemetry = `kind runId caseId requestId attemptId clientAttemptId invocationId instanceId processId role localSequence localElapsedMs revision sourceHash uid route model status reason stage code durationMs elapsedMs value instanceValue active queued limit attempt deadlineMs requestDeadlineMs remaining retryAfterMs retryable admitted dispatched settled cancelled aborted sequence index bytes count transactionAttempts backendRunId`.split(' ');
export function redactEntry(entry, stream, correlation) {
    const result = pick(entry, ['insertId', 'logName', 'timestamp', 'receiveTimestamp', 'severity', 'trace', 'spanId', 'traceSampled']);
    result.resource = { type: entry.resource?.type, labels: pick(entry.resource?.labels, ['project_id', 'service_name', 'location', 'revision_name', 'configuration_name', 'service', 'method']) };
    if (stream === 'application') {
        result.jsonPayload = Object.fromEntries(Object.entries(pick(entry.jsonPayload, telemetry))
            .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
    } else if (stream === 'http-request') {
        result.httpRequest = pick(entry.httpRequest, ['requestMethod', 'status', 'requestSize', 'responseSize', 'latency', 'protocol']);
        const url = new URL(entry.httpRequest.requestUrl);
        result.httpRequest.requestUrl = url.origin + url.pathname;
    } else {
        const p = entry.protoPayload;
        result.protoPayload = pick(p, ['@type', 'serviceName', 'methodName', 'resourceName', 'numResponseItems']);
        result.protoPayload.status = pick(p.status, ['code']);
        result.protoPayload.metadata = pick(p.metadata, ['@type', 'transactionId', 'processingDuration', 'keyCount']);
        result.protoPayload.metadata.keys = correlation.paths;
        // Retain the operation targets, never write fields or opaque transaction tokens.
        result.protoPayload.request = { '@type': p.request?.['@type'], documents: correlation.paths };
    }
    return result;
}
