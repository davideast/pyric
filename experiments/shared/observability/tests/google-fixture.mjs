// A stateful Google API boundary fixture. No production credentials or SDK calls.
export function googleFixture() {
    const permissions = ['resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy', 'logging.buckets.create', 'logging.buckets.update', 'logging.sinks.create', 'logging.sinks.update', 'firebaseauth.configs.update'];
    const state = {
        policy: { version: 3, etag: 'original-etag', bindings: [{ role: 'roles/viewer', members: ['user:existing@example.com'], condition: { title: 'temporary', expression: 'true' } }],
            auditConfigs: [{ service: 'storage.googleapis.com', auditLogConfigs: [{ logType: 'DATA_READ', exemptedMembers: ['user:existing@example.com'] }] }] },
        project: { projectId: 'test-project' },
        database: { name: 'projects/test-project/databases/test-db', uid: 'database-instance',
            earliestVersionTime: '2026-09-19T00:00:00Z', etag: 'database-clock-etag' },
        run: { uri: 'https://experiment-xyz-uc.a.run.app', template: { serviceAccount: 'runtime@test-project.iam.gserviceaccount.com' } },
        auth: { monitoring: { requestLogging: { enabled: false } }, signIn: { email: { enabled: true } } },
        ancestors: {}, bucket: null, sink: null, denied: [], mutations: [], calls: [], logs: {},
    };
    const error = status => { throw Object.assign(new Error(`fixture HTTP ${status}`), { status }); };
    const api = { identity: 'serviceAccount:collector@test-project.iam.gserviceaccount.com', async request(method, url, body) {
        state.calls.push({ method, url, body: structuredClone(body) });
        const path = new URL(url).pathname;
        if (state.denied.some(s => path.endsWith(s))) return error(403);
        if (path.endsWith(':testIamPermissions')) {
            const result = body.permissions.filter(p => permissions.includes(p));
            if (state.policy.bindings.some(b => b.role === 'roles/logging.privateLogViewer' && !b.condition && b.members.includes(api.identity))) result.push('logging.logEntries.list', 'logging.privateLogEntries.list');
            if (state.policy.bindings.some(b => b.role === 'roles/logging.viewAccessor' && !b.condition && b.members.includes(api.identity))) result.push('logging.views.access');
            return { permissions: [...new Set(result)].filter(p => body.permissions.includes(p)) };
        }
        if (path.endsWith(':getIamPolicy')) {
            if (path.includes('/v3/')) return structuredClone(state.ancestors[path.replace('/v3/', '').replace(':getIamPolicy', '')] ?? error(403));
            return structuredClone(state.policy);
        }
        if (method === 'GET' && path === '/v1/projects/test-project') return structuredClone(state.project);
        if (method === 'GET' && path.includes('/services/')) return structuredClone(state.run);
        if (method === 'GET' && path.includes('/databases/')) return structuredClone(state.database);
        if (method === 'GET' && path.endsWith('/config')) return structuredClone(state.auth);
        if (method === 'GET' && path.includes('/buckets/')) return structuredClone(state.bucket ?? error(404));
        if (method === 'GET' && path.includes('/sinks/')) return structuredClone(state.sink ?? error(404));
        if (path.endsWith('/entries:list')) {
            const kind = Object.keys(state.logs).find(k => body.filter.includes(k));
            return structuredClone({ entries: state.logs[kind] ?? [] });
        }
        state.mutations.push({ method, url, body: structuredClone(body) });
        if (path.endsWith(':setIamPolicy')) {
            if (body.policy.etag !== state.policy.etag) return error(409);
            for (const field of (body.updateMask ?? 'bindings,etag').split(',')) {
                if (body.policy[field] !== undefined) state.policy[field] = structuredClone(body.policy[field]);
            }
            state.policy.etag = 'next-etag'; return state.policy;
        }
        if (method === 'POST' && path.endsWith('/buckets')) { state.bucket = { ...body, lifecycleState: 'ACTIVE' }; return state.bucket; }
        if (method === 'PATCH' && path.includes('/buckets/')) { state.bucket = { ...state.bucket, ...body }; return state.bucket; }
        if (method === 'POST' && path.endsWith('/sinks')) { state.sink = structuredClone(body); return state.sink; }
        if (method === 'PATCH' && path.endsWith('/config')) { state.auth.monitoring.requestLogging.enabled = body.monitoring.requestLogging.enabled; return state.auth; }
        throw new Error(`Unhandled fixture request ${method} ${path}`);
    } };
    return { api, state, permissions };
}
