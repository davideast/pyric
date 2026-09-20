function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = q => sorted.length ? sorted[Math.ceil(q * sorted.length) - 1] : null;
    return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1) ?? null };
}
export function summarizeHttp(result) {
    return Object.fromEntries(result.cases.map(row => {
        const events = result.events.filter(e => e.caseId === row.id);
        const of = kind => events.filter(e => e.kind === kind);
        const client = of('client-response');
        const clientOutcomes = {};
        const latency = {};
        for (const event of client) {
            clientOutcomes[event.status] = (clientOutcomes[event.status] ?? 0) + 1;
            (latency[`${event.uid}/${event.status}`] ??= []).push(event.durationMs);
        }
        const server = of('server-ready')[0];
        const generator = of('generator-ready')[0];
        const closed = of('http-closed');
        const settlements = of('request-work-settled');
        // Join using server-local IDs and clocks only. Never subtract cross-process clocks.
        const afterResponseMs = [];
        for (const settled of settlements) {
            const response = of('request-response').find(e => e.attemptId === settled.attemptId);
            if (response && settled.localElapsedMs > response.localElapsedMs)
                afterResponseMs.push(settled.localElapsedMs - response.localElapsedMs);
        }
        let execution = null;
        if (of('provider-active').length) {
            execution = {
                    peakActiveProviderCalls: Math.max(...of('provider-active').map(e => e.instanceValue)),
                    peakActiveProviderCallsPerUser: Math.max(...of('provider-active').map(e => e.value)),
                    peakReservedExecutionSlots: Math.max(...of('execution-reservation').map(e => e.instanceValue)),
                    finalReservedExecutionSlots: of('execution-reservation').at(-1)?.instanceValue ?? null,
                    cancellationRequests: of('provider-cancel-requested').length,
                    cancellationConfirmations: of('provider-cancel-confirmed').length,
                    executionBusy: client.filter(e => e.status === 'execution_busy').length,
                    inferenceTimeouts: client.filter(e => e.status === 'inference_timeout').length,
                    providerFailures: of('provider-error').filter(e => e.outcome === 'provider_failure').length,
                    chunksReceived: of('client-chunk').length,
                    settlementAfterResponse: distribution(afterResponseMs),
                    providerDuration: distribution(of('provider-settled').flatMap(settled => {
                        const start = of('inference-dispatch').find(e => e.attemptId === settled.attemptId && e.instanceId === settled.instanceId);
                        return start ? [settled.localElapsedMs - start.localElapsedMs] : [];
                    })),
            };
        }
        return [row.id, {
                server: server ? { pid: server.processId, nodeVersion: server.nodeVersion, expressVersion: server.expressVersion } : null,
                client: generator ? { pid: generator.processId, nodeVersion: generator.nodeVersion } : null,
                dispatched: of('client-dispatch').length, responses: client.length,
                transportErrors: of('client-error').length, disconnected: of('client-disconnected').length,
                clientOutcomes, latencyByUserOutcome: Object.fromEntries(Object.entries(latency).map(([key, values]) => [key, distribution(values)])),
                schedulerLag: distribution(of('client-dispatch').map(e => e.schedulerLagMs)),
                peakInstanceAdmission: Math.max(0, ...of('outstanding').map(e => e.instanceValue)),
                peakUserAdmission: Math.max(0, ...of('outstanding').map(e => e.value)),
                transactionAttempts: of('transaction-attempt').length,
                inferenceDispatches: of('inference-dispatch').length,
                unfinishedHttpCloses: closed.filter(e => !e.finished).length,
                settlementAfterResponse: distribution(afterResponseMs),
                peakSampledRssBytes: Math.max(0, ...of('server-resource-sample').map(e => e.rssBytes)),
                resources: of('server-resource-summary')[0] ?? null,
                execution,
            }];
    }));
}
