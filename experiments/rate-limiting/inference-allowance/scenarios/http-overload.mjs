import { executionChecks } from '../analysis/execution-checks.mjs';
// HTTP workloads have their own registry; the original direct-call suite is unchanged.
const normal = () => Array.from({ length: 6 }, (_, i) => ({
    id: `normal-${i}`, uid: i % 2 ? 'carol' : 'bob', atMs: i * 30,
}));
const burst = () => [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `burst-${i}`, uid: 'alice', atMs: 0 })),
    ...normal().map(item => ({ ...item, atMs: item.atMs + 100 })),
];
const commonChecks = ['all scheduled requests observed', 'no client transport errors', 'HTTP status matches outcome', 'normal users complete', 'all work settles'];
const burstCase = options => ({
    checks: [...commonChecks, 'excess requests avoid database', 'Alice peak matches guard', 'burst rejection count'],
    schedule: burst(), options: { deadlineMs: 2000, ...options },
    delay: { boundary: 'beforeRead', uid: 'alice', durationMs: 600 },
});
const drainCase = disconnect => ({
    checks: [...commonChecks, 'excess requests avoid database', 'retry blocked until settlement', 'recovery succeeds',
        'expired admissions never dispatch', 'timed out work settles after response', 'disconnects observed'],
    options: { deadlineMs: 200, maxOutstandingPerUid: 2, maxOutstanding: 16 },
    delay: { boundary: 'afterCommit', uid: 'alice', durationMs: 1200, requestIds: ['held-0', 'held-1'] },
    schedule: [
        ...Array.from({ length: 2 }, (_, i) => ({ id: `held-${i}`, uid: 'alice', atMs: 0, disconnectMs: disconnect ? 50 : undefined })),
        ...normal().map(item => ({ ...item, atMs: item.atMs + 100 })),
        { id: 'retry', uid: 'alice', atMs: 400 },
        { id: 'recovered', uid: 'alice', atMs: 1500 },
    ],
});
const instanceDrain = drainCase(true);
instanceDrain.checks = instanceDrain.checks.filter(name => name !== 'normal users complete');
instanceDrain.options.maxOutstanding = 2;
instanceDrain.delay.uid = '*';
instanceDrain.schedule = instanceDrain.schedule.filter(item => !['bob', 'carol'].includes(item.uid)).map(item => ({
    ...item, uid: item.id === 'held-0' ? 'alice' : item.id === 'held-1' ? 'dave' : 'eve',
}));
const streamCase = cancellation => ({
    execution: true,
    checks: ['all scheduled requests observed', 'no client transport errors', 'HTTP status matches outcome', 'all work settles', 'excess requests avoid database'],
    options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 4, inferenceTimeoutMs: 1500 },
    provider: { delayMs: 40, delayByRequest: { held: 600 }, chunks: 3, cancellation: cancellation ?? 'ignore', cancelDelayMs: 200 },
    schedule: [
        { id: 'held', uid: 'alice', atMs: 0, stream: true, disconnectOnChunk: Boolean(cancellation) },
        { id: 'retry', uid: 'alice', atMs: 250 },
        { id: 'other', uid: 'bob', atMs: 300 },
        { id: 'recovered', uid: 'alice', atMs: 850 },
    ],
});
const executionBurst = guarded => ({
    execution: true,
    options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: guarded ? 1 : undefined, maxExecution: guarded ? 2 : undefined },
    provider: { delayMs: 600 },
    schedule: Array.from({ length: 6 }, (_, i) => ({ id: `burst-${i}`, uid: `user${i}`, atMs: i * 30 })),
    negative: guarded ? [] : ['execution capacity bound'],
});
export const httpScenarios = {
    'execution-admission-only': executionBurst(false),
    'execution-instance-guard': executionBurst(true),
    'execution-sustained': {
        execution: true,
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 3, inferenceTimeoutMs: 2000 },
        provider: { delayMs: 40, delayByRequest: Object.fromEntries(Array.from({length:24},(_,i)=>[`hot-${i}`,500])) },
        schedule: [
            ...Array.from({length:24},(_,i)=>({id:`hot-${i}`,uid:'alice',atMs:i*80})),
            ...Array.from({length:6},(_,i)=>({id:`normal-${i}`,uid:i%2?'carol':'bob',atMs:150+Math.floor(i/2)*700})),
        ],
    },
    'execution-provider-error': {
        execution: true,
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 3 },
        provider: { delayMs:40,delayByRequest:{held:250},failures:['held'] },
        schedule:[{id:'held',uid:'alice',atMs:0},{id:'repeat',requestId:'held',uid:'alice',atMs:450},{id:'recovered',uid:'alice',atMs:700}],
    },
    'execution-stream': streamCase(),
    'execution-disconnect-ignored': streamCase('ignore'),
    'execution-cancel-confirmed': streamCase('confirm'),
    'execution-timeout-ignored': {
        execution: true,
        checks: ['all scheduled requests observed', 'no client transport errors', 'HTTP status matches outcome', 'all work settles', 'excess requests avoid database'],
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 4, inferenceTimeoutMs: 200 },
        provider: { delayMs: 40, delayByRequest: { held: 650 }, cancellation: 'ignore' },
        schedule: [
            { id: 'held', uid: 'alice', atMs: 0 },
            { id: 'retry', uid: 'alice', atMs: 350 },
            { id: 'other', uid: 'bob', atMs: 400 },
            { id: 'recovered', uid: 'alice', atMs: 950 },
        ],
    },
    'execution-user-guard': {
        execution: true,
        checks: ['all scheduled requests observed', 'no client transport errors', 'HTTP status matches outcome', 'all work settles', 'excess requests avoid database'],
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16, maxExecutionPerUid: 1, maxExecution: 4 },
        provider: { delayMs: 600 },
        schedule: [
            { id: 'held', uid: 'alice', atMs: 0 },
            { id: 'retry', uid: 'alice', atMs: 150 },
            { id: 'other', uid: 'bob', atMs: 200 },
            { id: 'recovered', uid: 'alice', atMs: 900 },
        ],
    },
    'http-instance-drain': instanceDrain,
    'http-timeout-drain': drainCase(false),
    'http-disconnect-drain': drainCase(true),
    'http-instance-guard': {
        checks: ['all scheduled requests observed', 'no client transport errors', 'HTTP status matches outcome', 'all work settles', 'excess requests avoid database', 'instance peak matches guard', 'instance outcomes'],
        schedule: Array.from({ length: 20 }, (_, i) => ({ id: `many-${i}`, uid: `user${i}`, atMs: 0 })),
        options: { deadlineMs: 2000, maxOutstandingPerUid: 2, maxOutstanding: 16 },
        delay: { boundary: 'beforeRead', uid: '*', durationMs: 600 },
    },
    'http-unguarded': burstCase({}),
    'http-user-guard': burstCase({ maxOutstandingPerUid: 2 }),
    'http-combined-guard': burstCase({ maxOutstandingPerUid: 2, maxOutstanding: 16 }),
    'http-normal': {
        checks: commonChecks,
        schedule: normal(), options: { deadlineMs: 2000 },
    },
};
for (const [id, scenario] of Object.entries(httpScenarios)) {
    if (!scenario.execution) continue;
    scenario.executionLimit = { perUid: scenario.options.maxExecutionPerUid ?? 1, instance: scenario.options.maxExecution ?? 2 };
    scenario.checks = ['all scheduled requests observed', 'no client transport errors', 'HTTP status matches outcome', 'all work settles',
        ...executionChecks.filter(name => !['execution retry rejected','execution recovery succeeds'].includes(name))];
    if (scenario.schedule.some(item => item.id === 'retry')) scenario.checks.push('execution retry rejected');
    if (scenario.schedule.some(item => item.id === 'recovered')) scenario.checks.push('execution recovery succeeds');
    if (scenario.schedule.some(item => item.stream)) scenario.checks.push('stream delivered before settlement');
    if (id === 'execution-instance-guard') scenario.checks.push('execution instance saturation');
    if (id === 'execution-timeout-ignored') scenario.checks.push('inference deadline observed');
    if (id === 'execution-sustained') scenario.checks.push('execution normal users complete');
    if (id === 'execution-cancel-confirmed') scenario.checks.push('cancellation confirmed');
    if (['execution-timeout-ignored','execution-disconnect-ignored'].includes(id)) scenario.checks.push('cancellation ignored');
    if (id === 'execution-provider-error') scenario.checks.push('provider failure does not redispatch');
}
export const httpWorkload = {
    revision: 1, suite: 'http-overload', clockStart: 1000000, maxAttempts: 8,
    server: 'node-express-single-instance', generator: 'separate-node-process-open-loop',
    inference: 'fake-immediate', authentication: 'synthetic fixture bearer tokens; not Firebase token verification',
    caseTimeoutMs: 15000,
};
