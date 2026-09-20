import { summarizeLifecycle } from './provider-lifecycle.mjs';
import { summarizeHttp } from './http-summary.mjs';
import { assessRun } from './assess.mjs';
const percentile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1] : null;
export function summarize(result) {
    const groups = {};
    for (const e of result.events.filter(e => e.kind === 'request-response')) {
        const key = `${e.caseId}/${e.uid ?? 'signed-out'}/${e.status}`;
        (groups[key] ??= []).push(e.durationMs);
    }
    const outstanding = {};
    for (const e of result.events.filter(e => e.kind === 'outstanding')) {
        const key = `${e.caseId}/${e.uid}/${e.instanceId}`;
        outstanding[key] = Math.max(outstanding[key] ?? 0, e.value);
    }
    return { ...(result.run.suite === 'provider-lifecycle' ? { lifecycle: summarizeLifecycle(result) } : {}), ...(result.run.suite === 'http-overload' ? { http: summarizeHttp(result) } : {}), assessment: assessRun(result), cases: result.cases.length, requests: result.events.filter(e => e.kind === 'request-response').length,
        inferenceDispatches: result.inferences.length, checks: result.assertions.length,
        transactionAttempts: result.events.filter(e => e.kind === 'transaction-attempt').length,
        acknowledgedTransactions: result.events.filter(e => e.kind === 'transaction-acknowledged').length,
        latencyByCaseUserOutcome: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, { samples: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), maxMs: Math.max(...values) }])),
        peakOutstandingByCaseUserInstance: outstanding, billableReads: null, billableWrites: null,
        limitations: ['Elapsed time is local process time, not a production capacity estimate.', 'Transaction reads/staged writes are SDK observations, not billing units.', 'Fault delays are injected and named by scenario.', 'Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.'] };
}
export function findings(result) {
    const summary = summarize(result);
    return `# Inference allowance experiment ${result.run.id}

${summary.cases} cases; ${summary.requests} requests; ${summary.checks} checks.

Assessment: ${summary.assessment.successfulExperiment ? 'expected evidence observed' : 'unexpected or incomplete evidence'}. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
` + result.assertions.map(a => `| ${a.caseId} | ${a.name} | ${JSON.stringify(a.actual)} | ${JSON.stringify(a.expected)} | ${a.passed} |`).join('\n') + '\n\n' + summary.limitations.map(s => '- ' + s).join('\n') + '\n';
}
