import { scenarios } from '../harness/runner.mjs';
export async function preflight(config, { probe = false, credential = undefined, fetchImpl = (url, options) => fetch(url, options) } = {}) {
    const checks = [];
    let database = null, networkAccessed = false;
    const add = (name, status, detail) => checks.push({ name, status, detail });
    if (config.profile === 'local')
        return { ready: true, checks: [{ name: 'local only', status: 'passed' }] };
    add('profile', ['firestore-comparison', 'production-integration'].includes(config.profile) ? 'passed' : 'failed', 'Only explicit experiment profiles');
    add('project', /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.projectId ?? '') ? 'passed' : 'failed', 'Named test project required');
    add('database', /^[a-zA-Z0-9_-]+$/.test(config.databaseId ?? '') ? 'passed' : 'failed', 'Explicit dedicated database; no default fallback');
    if (config.profile === 'production-integration') {
        let secure = false;
        try {
            const url = new URL(config.gatewayUrl);
            secure = url.protocol === 'https:' && !url.username && !url.password && !url.search;
        }
        catch { }
        add('gateway HTTPS', secure ? 'passed' : 'failed', 'Tokens are never sent to a plaintext or redirecting target');
        add('inference route', config.inference?.api === 'generateContent' ? 'passed' : 'failed', 'Initial integration supports only non-streaming generateContent; streaming/Live hook coverage is absent');
        add('request limits', Number.isInteger(config.limits?.maxRequests) && config.limits.maxRequests > 0 && config.limits.maxRequests <= 50 && Number.isInteger(config.limits?.maxInferenceDispatches) && config.limits.maxInferenceDispatches > 0 && config.limits.maxInferenceDispatches <= 5 ? 'passed' : 'failed', 'Initial supervised smoke ceiling: 50 requests, 5 inference dispatches');
        add('deployed enforcement coverage', 'unverified', 'Must inspect and exercise deployed gateway/hook, direct AI Logic bypass, and server-side dispatch budget; configuration is not evidence');
        add('deployment and identity', 'unverified', 'Need deployed revision hash, verified test-user tokens, App Check, and correlated service logs');
    }
    else {
        add('inference', config.inference?.provider === 'fake' ? 'passed' : 'failed', 'Firestore comparison never sends paid inference');
        add('explicit cases', Array.isArray(config.cases) && config.cases.length > 0 && new Set(config.cases).size === config.cases.length && config.cases.every(id => scenarios[id] && !scenarios[id].requires?.length) ? 'passed' : 'failed', 'Select known cases supported by the Admin adapter');
        add('request ceiling', Number.isInteger(config.limits?.maxRequests) && config.limits.maxRequests > 0 && config.limits.maxRequests <= 200 ? 'passed' : 'failed', 'At most 200 gateway requests per hosted comparison');
        add('hosted target', process.env.FIRESTORE_EMULATOR_HOST ? 'failed' : 'passed', 'An emulator cannot be labeled hosted Firestore');
        if (probe && checks.every(c => c.status === 'passed')) {
            networkAccessed = true;
            try {
                database = await probeDatabase(config, credential, fetchImpl);
                add('ADC and database mode', 'passed', 'Database metadata read successfully; this does not prove document write permission or deployed Rules');
            }
            catch {
                add('ADC and database mode', 'failed', 'Database probe failed or returned unsupported metadata; check ADC, database access and Native mode');
            }
        }
        else
            add('ADC and database mode', 'unverified', 'Use preflight --probe to read database metadata; offline validation cannot establish connectivity');
    }
    return { ready: checks.every(c => c.status === 'passed'), configurationValid: checks.every(c => c.status !== 'failed'), checks, networkAccessed, database };
}
async function probeDatabase(config, credential, fetchImpl) {
    const name = `projects/${config.projectId}/databases/${config.databaseId}`;
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('database_probe_timeout')); }, 10000); });
    const work = (async () => {
        const auth = credential ?? (await import('firebase-admin/app')).applicationDefault();
        const token = await auth.getAccessToken();
        abort.signal.throwIfAborted();
        const response = await fetchImpl(`https://firestore.googleapis.com/v1/${name}`, {
            method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: abort.signal,
        });
        if (!response.ok)
            throw new Error('database_metadata_unavailable');
        const data = await response.json();
        if (data.name !== name || data.type !== 'FIRESTORE_NATIVE' || !data.locationId ||
            !['PESSIMISTIC', 'OPTIMISTIC'].includes(data.concurrencyMode) || !['STANDARD', 'ENTERPRISE'].includes(data.databaseEdition))
            throw new Error('unsupported_database');
        return { name, locationId: data.locationId, type: data.type, concurrencyMode: data.concurrencyMode,
            databaseEdition: data.databaseEdition, observedAt: new Date().toISOString() };
    })();
    try {
        return await Promise.race([work, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
