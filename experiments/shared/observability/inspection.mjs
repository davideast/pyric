import { resources, services, sinkFilter, setupVersion, digest } from './requirements.mjs';

export async function observe(api, method, url, body) {
    try { return { state: 'observed', value: await api.request(method, url, body) }; }
    catch (error) {
        let state = 'error';
        if (error.status === 403 || error.status === 401) state = 'forbidden';
        if (error.status === 404) state = 'not-found';
        return { state, httpStatus: error.status ?? null, message: error.message };
    }
}

export async function inspect(api, collectorApi, config, manifest) {
    const urls = resources(config);
    const specs = {
        project: ['GET', urls.project],
        policy: ['POST', `${urls.project}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } }],
        permissions: ['POST', `${urls.project}:testIamPermissions`, { permissions: [
            'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
            'logging.buckets.create', 'logging.buckets.update', 'logging.sinks.create', 'logging.sinks.update',
            'firebaseauth.configs.update',
        ] }],
        run: ['GET', urls.run], database: ['GET', urls.database],
        bucket: ['GET', urls.bucket], sink: ['GET', urls.sink],
    };
    if (config.optional.includes('auth')) specs.auth = ['GET', urls.auth];
    const observations = Object.fromEntries(await Promise.all(Object.entries(specs).map(async ([key, args]) => [key, await observe(api, ...args)])));
    // Cloud Run container environment and Auth configuration can contain secrets.
    // Retain only the fields this setup actually evaluates.
    if (observations.run.state === 'observed') {
        const run = observations.run.value;
        observations.run.value = { name: run.name, uri: run.uri, generation: run.generation,
            latestReadyRevision: run.latestReadyRevision, template: { serviceAccount: run.template?.serviceAccount } };
    }
    if (observations.auth?.state === 'observed') {
        const auth = observations.auth.value;
        observations.auth.value = { name: auth.name, monitoring: { requestLogging: { enabled: auth.monitoring?.requestLogging?.enabled === true } } };
    }
    observations.collectorPermissions = await observe(collectorApi, 'POST', `${urls.project}:testIamPermissions`, {
        permissions: ['logging.logEntries.list', 'logging.privateLogEntries.list', 'logging.views.access'],
    });
    // Preserve ancestor evidence: inherited exemptions cannot be fixed at project scope.
    observations.ancestors = [];
    let parent = observations.project.value?.parent;
    if (parent?.type) parent = `${parent.type}s/${parent.id}`;
    for (let depth = 0; parent && depth < 10; depth++) {
        if (!/^(folders|organizations)\/\d+$/.test(parent)) {
            observations.ancestors.push({ state: 'error', message: 'Unsupported project ancestry' }); break;
        }
        const url = `https://cloudresourcemanager.googleapis.com/v3/${parent}`;
        const policy = await observe(api, 'POST', `${url}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } });
        observations.ancestors.push({ resource: parent, ...policy });
        if (parent.startsWith('organizations/')) break;
        const metadata = await observe(api, 'GET', url);
        if (metadata.state !== 'observed') { observations.ancestors.push(metadata); break; }
        parent = metadata.value.parent;
    }
    const checks = evaluate(config, manifest, observations);
    checks.push({ id: 'collector-identity', status: collectorApi.identity === config.collector ? 'ready' : 'unknown',
        detail: { expected: config.collector, observed: collectorApi.identity,
            guidance: 'Use credentials whose verified identity matches --collector; explicit service-account files are supported.' } });
    return { formatVersion: 1, setupVersion, manifest, manifestHash: digest(manifest), config,
        checkedAt: new Date().toISOString(), inspector: api.identity, collector: collectorApi.identity,
        observations, checks, configurationReady: checks.every(c => c.status === 'ready'),
        projectConfigurationReady: checks.filter(c => !isUnverifiedAncestry(c)).every(c => c.status === 'ready'),
        evidenceComplete: false, limitations: [...manifest.limitations, 'Ancestor log routing and IAM deny policies require end-to-end preflight.'] };
}

// Additive project setup is possible without ancestor IAM access. This is an
// evidence gap, not a grant to ignore missing project access or known exemptions.
export function isUnverifiedAncestry(check) {
    return check.id === 'inherited-auditing' && check.status === 'unknown';
}

function evaluate(config, manifest, observations) {
    const checks = [];
    const check = (id, status, detail) => checks.push({ id, status, detail });
    for (const key of ['project', 'policy', 'run', 'database']) {
        const observation = observations[key];
        const ready = observation.state === 'observed';
        check(key, ready ? 'ready' : 'unknown', ready ? 'Readable' : observation.state);
    }
    const runtime = observations.run.value?.template?.serviceAccount;
    check('runtime-identity', runtime ? 'ready' : 'unknown', runtime ?? 'Cannot inspect runtime service account');
    const inheritedKnown = observations.project.state === 'observed' && observations.ancestors.every(p => p.state === 'observed');
    check('inherited-auditing', inheritedKnown ? 'ready' : 'unknown', 'Ancestor policies are inspected where accessible. Unreadable policies remain unverified; project setup can proceed, but log delivery must pass preflight.');
    const policies = [observations.policy, ...observations.ancestors].filter(p => p.state === 'observed').map(p => p.value);
    for (const name of ['firestore', ...config.optional.filter(s => s === 'rtdb')]) {
        for (const category of manifest.auditCategories) {
            const matches = policies.flatMap(p => p.auditConfigs ?? []).filter(c => ['allServices', services[name]].includes(c.service))
                .flatMap(c => c.auditLogConfigs ?? []).filter(c => c.logType === category);
            const exemptions = matches.flatMap(c => c.exemptedMembers ?? []);
            // Groups, domains and special principals cannot be safely resolved here.
            const affected = exemptions.filter(m => m === `serviceAccount:${runtime}` || !m.startsWith('serviceAccount:'));
            let status = 'missing';
            if (!runtime || observations.policy.state !== 'observed') status = 'unknown';
            else if (affected.length) status = 'manual';
            else if (matches.length) status = 'ready';
            check(`${name}.${category}`, status, { scope: 'observed-policies', allAncestorPoliciesRead: inheritedKnown, relevantExemptions: affected });
        }
    }
    const bucket = observations.bucket;
    let bucketStatus = 'unknown';
    if (bucket.state === 'not-found') bucketStatus = 'missing';
    if (bucket.state === 'observed') {
        bucketStatus = bucket.value.retentionDays >= config.retentionDays && bucket.value.lifecycleState === 'ACTIVE' ? 'ready' : 'manual';
    }
    check('retention', bucketStatus, { requiredDays: config.retentionDays, observedDays: bucket.value?.retentionDays ?? null,
        guidance: 'Existing buckets require manual retention/lifecycle changes; setup never updates their retention because the API offers no conditional update.' });
    const sink = observations.sink;
    const expectedDestination = `logging.googleapis.com/${resources(config).bucketPath}`;
    let sinkStatus = 'unknown';
    if (sink.state === 'not-found') sinkStatus = 'missing';
    if (sink.state === 'observed') {
        const correct = sink.value.destination === expectedDestination && sink.value.filter === sinkFilter(config)
            && !sink.value.disabled && !(sink.value.exclusions ?? []).some(e => !e.disabled);
        sinkStatus = correct ? 'ready' : 'manual';
    }
    check('routing', sinkStatus, 'Dedicated sink; existing sinks/exclusions are never overwritten');
    const collector = observations.collectorPermissions;
    const granted = collector.value?.permissions ?? [];
    const canRead = ['logging.logEntries.list', 'logging.privateLogEntries.list', 'logging.views.access'].every(p => granted.includes(p));
    let collectorStatus = 'unknown';
    if (collector.state === 'observed') collectorStatus = canRead ? 'ready' : 'missing';
    check('collector-access', collectorStatus, { granted });
    if (config.optional.includes('auth')) {
        const auth = observations.auth;
        let authStatus = 'unknown';
        if (auth.state === 'observed') authStatus = auth.value.monitoring?.requestLogging?.enabled ? 'ready' : 'missing';
        check('auth-activity', authStatus, 'Identity Platform activity logging; existing configuration is preserved');
    }
    if (config.optional.includes('ai')) check('ai-monitoring', 'manual',
        `Enable and verify AI monitoring in https://console.firebase.google.com/project/${config.project}/ailogic; no supported setup API is assumed`);
    return checks;
}
