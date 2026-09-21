import { digest, resources, services, sinkFilter, setupVersion } from './requirements.mjs';
import { inspect, isUnverifiedAncestry } from './inspection.mjs';

function configurationFingerprint(observations) {
    const snapshot = structuredClone(observations);
    if (snapshot.database.state === 'observed') {
        // Firestore's retention horizon advances without a configuration edit,
        // changing the database etag too. This plan never mutates the database.
        // Keep identity, updateTime and all configuration fields in the guard.
        delete snapshot.database.value.earliestVersionTime;
        delete snapshot.database.value.etag;
    }
    return digest(snapshot);
}

export function plan(report) {
    const { config, observations: state, manifest } = report;
    const actions = [];
    const warnings = report.checks.filter(isUnverifiedAncestry);
    const blockers = report.checks.filter(c => ['unknown', 'manual'].includes(c.status) && !isUnverifiedAncestry(c));
    const urls = resources(config);
    if (state.policy.state === 'observed' && state.policy.value.etag) {
        const policy = structuredClone(state.policy.value);
        const audit = policy.auditConfigs ??= [];
        for (const name of ['firestore', ...config.optional.filter(s => s === 'rtdb')]) {
            let service = audit.find(c => c.service === services[name]);
            if (!service) { service = { service: services[name], auditLogConfigs: [] }; audit.push(service); }
            for (const logType of manifest.auditCategories) {
                if (!(service.auditLogConfigs ??= []).some(c => c.logType === logType)) service.auditLogConfigs.push({ logType });
            }
        }
        // Explicit, unconditional grants to the reviewed collector, not the runtime.
        for (const role of ['roles/logging.privateLogViewer', 'roles/logging.viewAccessor']) {
            let binding = (policy.bindings ??= []).find(b => b.role === role && !b.condition);
            if (!binding) { binding = { role, members: [] }; policy.bindings.push(binding); }
            if (!binding.members.includes(config.collector)) binding.members.push(config.collector);
        }
        if (digest(policy) !== digest(state.policy.value)) actions.push({ id: 'project-policy', method: 'POST', url: `${urls.project}:setIamPolicy`, body: { policy, updateMask: 'bindings,auditConfigs,etag' }, permission: 'resourcemanager.projects.setIamPolicy' });
    } else blockers.push({ id: 'project-policy', status: 'unknown', detail: 'Readable IAM policy and etag required' });
    if (state.bucket.state === 'not-found') actions.push({ id: 'create-bucket', method: 'POST', url: `${urls.buckets}?bucketId=${config.bucket}`,
        body: { retentionDays: config.retentionDays, description: 'Pyric experiment evidence' }, permission: 'logging.buckets.create' });
    if (state.sink.state === 'not-found') actions.push({ id: 'create-sink', method: 'POST', url: urls.sinks,
        body: { name: config.sink, destination: `logging.googleapis.com/${urls.bucketPath}`, filter: sinkFilter(config), description: 'Pyric experiment evidence' }, permission: 'logging.sinks.create' });
    if (state.auth?.state === 'observed' && !state.auth.value.monitoring?.requestLogging?.enabled) actions.push({ id: 'auth-activity', method: 'PATCH',
        url: `${urls.auth}?updateMask=monitoring.requestLogging.enabled`, body: { monitoring: { requestLogging: { enabled: true } } }, permission: 'firebaseauth.configs.update' });
    const granted = state.permissions.value?.permissions ?? [];
    for (const action of actions) if (!granted.includes(action.permission)) blockers.push({ id: action.id, status: 'permission-required', detail: action.permission });
    return { formatVersion: 1, setupVersion, manifestHash: report.manifestHash, createdAt: report.checkedAt,
        config, beforeHash: configurationFingerprint(state), actions, blockers, warnings,
        impacts: ['Adds audit logging at project scope; can increase log charges.', 'Creates a dedicated sink/bucket without modifying existing sinks.', 'Collector IAM grants apply to project logs.', 'No workloads, deployment, Rules changes or inference are performed by apply.'] };
}

export async function apply(api, collectorApi, saved, manifest, persist = async (_value) => {}) {
    if (saved.formatVersion !== 1 || saved.setupVersion !== setupVersion || saved.manifestHash !== digest(manifest)) throw new Error('Unsupported plan or changed requirements; create a new plan');
    const report = await inspect(api, collectorApi, saved.config, manifest);
    const fresh = plan(report);
    if (digest(fresh.actions) !== digest(saved.actions) || fresh.beforeHash !== saved.beforeHash) {
        // Reapplying a fulfilled plan is safe; do not silently fix different settings.
        if (fresh.actions.length === 0 && report.projectConfigurationReady) return { status: 'already-applied', completed: [], report };
        throw new Error('Configuration changed since planning; create a new plan. No changes applied.');
    }
    if (fresh.blockers.length) throw new Error('Plan has unresolved permissions, exemptions or manual checks; inspect blockers and re-plan');
    const completed = [];
    for (const action of fresh.actions) {
        try {
            await api.request(action.method, action.url, action.body);
            completed.push(action.id);
            await persist({ status: 'applying', completed });
        } catch (error) {
            const result = { status: 'partial', completed, failedAction: action.id, error: error.message };
            await persist(result);
            return result;
        }
    }
    const after = await inspect(api, collectorApi, saved.config, manifest);
    return { status: 'applied', completed, report: after };
}
