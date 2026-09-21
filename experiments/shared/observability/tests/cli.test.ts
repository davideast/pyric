import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../cli.mjs';
import { googleFixture } from './google-fixture.mjs';
import manifest from '../../../rate-limiting/inference-allowance/observability.json';

const target = ['--project', 'test-project', '--database', 'test-db', '--service', 'test-service', '--region', 'us-east4', '--collector', 'serviceAccount:collector@test-project.iam.gserviceaccount.com'];
async function scenario(run) {
    const out = await mkdtemp(join(tmpdir(), 'observability-test-'));
    const fixture = googleFixture();
    const cli = (args) => runCli([...args, '--out', out], manifest, { api: fixture.api, print: () => {} });
    const read = (name) => readFile(join(out, name), 'utf8').then(JSON.parse);
    try { await run({ ...fixture, out, cli, read }); } finally { await rm(out, { recursive: true, force: true }); }
}

test('unreadable ancestors warn without blocking additive project setup or claiming full readiness', () => scenario(async ({ state, out, cli, read }) => {
    state.project.parent = { type: 'folder', id: '123' };
    state.denied.push('/folders/123', '/folders/123:getIamPolicy');
    expect(await cli(['plan', ...target])).toBe(0);
    const planned = await read('observability-plan.json');
    expect(planned.blockers).toEqual([]);
    expect(planned.warnings.map(w => w.id)).toEqual(['inherited-auditing']);
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    const report = await read('observability-report.json');
    expect(report.projectConfigurationReady).toBe(true);
    expect(report.configurationReady).toBe(false);
    expect(report.evidenceComplete).toBe(false);
    expect(report.checks.find(c => c.id === 'inherited-auditing').status).toBe('unknown');
    expect(state.mutations.every(m => !m.url.includes('/v3/'))).toBe(true);
    const count = state.mutations.length;
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    expect(state.mutations).toHaveLength(count);
    expect(await cli(['check', ...target])).toBe(1);
}));

test('a visible exemption still blocks setup when other ancestor metadata is inaccessible', () => scenario(async ({ state, cli, read }) => {
    state.project.parent = { type: 'folder', id: '123' };
    state.ancestors['folders/123'] = { auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'DATA_READ', exemptedMembers: ['serviceAccount:runtime@test-project.iam.gserviceaccount.com'] }] }] };
    state.denied.push('/folders/123');
    expect(await cli(['plan', ...target])).toBe(1);
    const planned = await read('observability-plan.json');
    expect(planned.blockers.some(b => b.id === 'firestore.DATA_READ' && b.status === 'manual')).toBe(true);
    expect(state.mutations).toHaveLength(0);
}));

test('plan is read-only; apply preserves policy and a repeated apply is a no-op', () => scenario(async ({ state, out, cli, read }) => {
    expect(await cli(['check', ...target])).toBe(1);
    expect(await cli(['plan', ...target])).toBe(0);
    expect(state.mutations).toHaveLength(0);
    const saved = await read('observability-plan.json');
    expect(saved.actions.map(a => a.id)).toEqual(['project-policy', 'create-bucket', 'create-sink']);
    const policy = saved.actions[0].body.policy;
    expect(saved.actions[0].body.updateMask).toBe('bindings,auditConfigs,etag');
    expect(policy.etag).toBe('original-etag');
    expect(policy.bindings[0]).toEqual(state.policy.bindings[0]);
    expect(policy.auditConfigs[0]).toEqual(state.policy.auditConfigs[0]);
    expect(policy.auditConfigs[1].auditLogConfigs).toEqual([{ logType: 'ADMIN_READ' }, { logType: 'DATA_READ' }, { logType: 'DATA_WRITE' }]);
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    expect((await read('observability-report.json')).configurationReady).toBe(true);
    expect((await read('observability-report.json')).evidenceComplete).toBe(false);
    const writes = state.mutations.length;
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    expect(state.mutations).toHaveLength(writes);
}));

test('existing short retention requires manual review and cannot race a retention update', () => scenario(async ({ state, out, cli, read }) => {
    state.bucket = { retentionDays: 30, lifecycleState: 'ACTIVE' };
    expect(await cli(['plan', ...target])).toBe(1);
    const saved = await read('observability-plan.json');
    expect(saved.blockers.some(c => c.id === 'retention')).toBe(true);
    expect(saved.actions.some(a => a.method === 'PATCH' && a.url.includes('/buckets/'))).toBe(false);
    await expect(cli(['apply', '--plan', join(out, 'observability-plan.json')])).rejects.toThrow('unresolved');
    state.bucket.retentionDays = 365;
    await expect(cli(['apply', '--plan', join(out, 'observability-plan.json')])).rejects.toThrow('changed');
    expect(state.bucket.retentionDays).toBe(365);
    expect(state.mutations).toHaveLength(0);
}));

test('default database is supported and retention cannot undercut the manifest', () => scenario(async ({ cli, read, state }) => {
    const args = target.map(value => value === 'test-db' ? '(default)' : value);
    expect(await cli(['plan', ...args])).toBe(0);
    expect((await read('observability-plan.json')).config.database).toBe('(default)');
    expect(state.calls.some(call => call.url.endsWith('/databases/(default)'))).toBe(true);
    await expect(cli(['plan', ...target, '--retention', '30'])).rejects.toThrow('90–3650');
    expect(state.mutations).toHaveLength(0);
}));

test('unresolved ADC identity never passes collector verification even with log permissions', () => scenario(async ({ api, state, cli, read }) => {
    api.identity = 'unresolved-application-default-credentials';
    state.policy.bindings.push({ role: 'roles/logging.privateLogViewer', members: [api.identity] });
    state.policy.bindings.push({ role: 'roles/logging.viewAccessor', members: [api.identity] });
    expect(await cli(['plan', ...target])).toBe(1);
    const report = await read('observability-report.json');
    expect(report.checks.find(c => c.id === 'collector-access').status).toBe('ready');
    expect(report.checks.find(c => c.id === 'collector-identity').status).toBe('unknown');
    expect(report.configurationReady).toBe(false);
    expect((await read('observability-plan.json')).blockers.some(c => c.id === 'collector-identity')).toBe(true);
    api.identity = 'user:someone-else@example.com';
    await expect(cli(['check', ...target])).rejects.toThrow('does not match');
    expect(state.mutations).toHaveLength(0);
}));

test('permission denial is unknown, not disabled, and cannot produce an applicable plan', () => scenario(async ({ state, out, cli, read }) => {
    state.denied.push(':getIamPolicy');
    expect(await cli(['plan', ...target])).toBe(1);
    const report = await read('observability-report.json');
    expect(report.observations.policy.state).toBe('forbidden');
    expect(report.checks.find(c => c.id === 'firestore.DATA_READ').status).toBe('unknown');
    await expect(cli(['apply', '--plan', join(out, 'observability-plan.json')])).rejects.toThrow('unresolved');
    expect(state.mutations).toHaveLength(0);
}));

test('stale configuration or tampered actions stop before any mutations', () => scenario(async ({ state, out, cli, read }) => {
    await cli(['plan', ...target]);
    const saved = await read('observability-plan.json');
    state.policy.etag = 'someone-edited';
    await expect(cli(['apply', '--plan', join(out, 'observability-plan.json')])).rejects.toThrow('changed');
    state.policy.etag = 'original-etag';
    saved.actions[0].body.policy.bindings = [];
    await writeFile(join(out, 'observability-plan.json'), JSON.stringify(saved));
    await expect(cli(['apply', '--plan', join(out, 'observability-plan.json')])).rejects.toThrow('changed');
    expect(state.mutations).toHaveLength(0);
}));

test('rolling Firestore retention metadata does not invalidate an unchanged logging plan', () => scenario(async ({ state, out, cli, read }) => {
    await cli(['plan', ...target]);
    state.database.earliestVersionTime = '2026-09-19T00:05:00Z';
    state.database.etag = 'advanced-clock-etag';
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    expect((await read('observability-report.json')).observations.database.value.earliestVersionTime).toBe(state.database.earliestVersionTime);
}));

test('database replacement still invalidates the logging plan', () => scenario(async ({ state, out, cli }) => {
    await cli(['plan', ...target]);
    state.database.uid = 'replaced-database';
    await expect(cli(['apply', '--plan', join(out, 'observability-plan.json')])).rejects.toThrow('changed');
    expect(state.mutations).toHaveLength(0);
}));

test('a longer retention period and unrelated exemptions survive setup', () => scenario(async ({ state, out, cli, read }) => {
    state.bucket = { retentionDays: 365, lifecycleState: 'ACTIVE' };
    state.policy.auditConfigs.push({ service: 'datastore.googleapis.com', auditLogConfigs: [{ logType: 'DATA_READ', exemptedMembers: ['serviceAccount:unrelated@test-project.iam.gserviceaccount.com'] }] });
    await cli(['plan', ...target]);
    expect((await read('observability-plan.json')).actions.map(a => a.id)).not.toContain('extend-retention');
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    expect(state.bucket.retentionDays).toBe(365);
    expect(state.policy.auditConfigs[1].auditLogConfigs[0].exemptedMembers).toHaveLength(1);
}));

test('inherited runtime exemptions block activation without deleting exemptions', () => scenario(async ({ state, cli, read }) => {
    state.project.parent = { type: 'organization', id: '123' };
    state.ancestors['organizations/123'] = { auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'DATA_READ', exemptedMembers: ['serviceAccount:runtime@test-project.iam.gserviceaccount.com'] }] }] };
    expect(await cli(['plan', ...target])).toBe(1);
    expect((await read('observability-plan.json')).blockers.some(c => c.id === 'firestore.DATA_READ')).toBe(true);
    expect(state.mutations).toHaveLength(0);
}));

test('conflicting existing sink is reported for manual review, never overwritten', () => scenario(async ({ state, cli, read }) => {
    state.sink = { destination: 'somewhere-else', filter: '', exclusions: [{ name: 'exclude', filter: 'true' }] };
    expect(await cli(['plan', ...target])).toBe(1);
    expect((await read('observability-plan.json')).blockers.some(c => c.id === 'routing')).toBe(true);
    expect(state.mutations).toHaveLength(0);
}));

test('optional services are opt-in, Auth uses a field mask, AI remains an explicit manual check', () => scenario(async ({ state, cli, out, read }) => {
    expect(await cli(['plan', ...target, '--optional', 'auth,rtdb'])).toBe(0);
    const plan = await read('observability-plan.json');
    expect(plan.actions.find(a => a.id === 'auth-activity').url).toContain('updateMask=monitoring.requestLogging.enabled');
    expect(await cli(['apply', '--plan', join(out, 'observability-plan.json')])).toBe(0);
    expect(state.auth.signIn.email.enabled).toBe(true);
    expect(state.auth.monitoring.requestLogging.enabled).toBe(true);
    expect(state.policy.auditConfigs.some(c => c.service === 'firebasedatabase.googleapis.com')).toBe(true);
    expect(await cli(['check', ...target, '--optional', 'ai'])).toBe(1);
    expect((await read('observability-report.json')).checks.find(c => c.id === 'ai-monitoring').status).toBe('manual');
}));

test('partial failures save the actions completed and stop without replaying mutations', () => scenario(async ({ state, cli, out, read }) => {
    await cli(['plan', ...target]);
    const saved = await read('observability-plan.json');
    const original = state.policy;
    // Fail create-bucket at the API boundary, after the policy write.
    const { runCli } = await import('../cli.mjs');
    const fixture = googleFixture();
    fixture.state.policy = original;
    const request = fixture.api.request.bind(fixture.api);
    fixture.api.request = async (method, url, body) => {
        if (method === 'POST' && url.includes('/buckets?')) throw Object.assign(new Error('quota exceeded'), { status: 429 });
        return request(method, url, body);
    };
    await writeFile(join(out, 'observability-plan.json'), JSON.stringify(saved));
    expect(await runCli(['apply', '--plan', join(out, 'observability-plan.json'), '--out', out], manifest, { api: fixture.api, print: () => {} })).toBe(1);
    const result = await read('apply-result.json');
    expect(result.status).toBe('partial');
    expect(result.completed).toEqual(['project-policy']);
    expect(result.failedAction).toBe('create-bucket');
}));
