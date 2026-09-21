export const caseIds = ['normal-response', 'normal-stream', 'abort-before-dispatch', 'abort-after-chunk'];
export function validateConfig(config) {
    const segment = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
    if (!config || Object.keys(config).some(k => !['projectId', 'databaseId', 'appId', 'model', 'limits'].includes(k))) throw new Error('Unknown live configuration fields; credentials must stay outside configuration');
    if (!segment(config.projectId) || !segment(config.databaseId) || config.databaseId === '(default)' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(config.appId) || !/^[a-zA-Z0-9.-]{1,100}$/.test(config.model)) throw new Error('Explicit project, dedicated database, app and model required');
    const limits = config.limits;
    if (!limits || Object.keys(limits).sort().join(',') !== ['maxConcurrent','maxDispatches','maxOutputTokens','requestDeadlineMs','runDeadlineMs'].sort().join(',')) throw new Error('Explicit bounded live limits required');
    for (const [name, cap] of Object.entries({ maxDispatches: 12, maxConcurrent: 2, maxOutputTokens: 64, requestDeadlineMs: 30000, runDeadlineMs: 180000 })) {
        if (!Number.isInteger(limits[name]) || limits[name] < 1 || limits[name] > cap) throw new Error('Invalid live limit: ' + name);
    }
    if (limits.maxDispatches < 3) throw new Error('Declared four-case workload requires a three-dispatch budget');
    return config;
}
