import { expect, test } from 'bun:test';
import { runHttpExperiment } from '../harness/http-runner.mjs';
test('HTTP baseline uses separate Node server and open-loop client processes and completes normal traffic', async () => {
    const result = await runHttpExperiment({ cases: ['http-normal'] });
    expect(result.cases).toEqual([{ id: 'http-normal', status: 'complete' }]);
    const servers = result.events.filter(e => e.kind === 'server-ready');
    const clients = result.events.filter(e => e.kind === 'generator-ready');
    expect(servers).toHaveLength(1);
    expect(clients).toHaveLength(1);
    expect(servers[0].runtime).toBe('node');
    expect(clients[0].runtime).toBe('node');
    expect(new Set([process.pid, servers[0].processId, clients[0].processId]).size).toBe(3);
    const responses = result.events.filter(e => e.kind === 'client-response');
    expect(responses).toHaveLength(6);
    expect(responses.every(e => e.httpStatus === 200 && e.status === 'completed')).toBe(true);
    expect(result.assertions.length).toBeGreaterThan(0);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 20000);
test('per-user admission rejects excess HTTP burst traffic before any database transaction and preserves other users', async () => {
    const result = await runHttpExperiment({ cases: ['http-unguarded', 'http-user-guard', 'http-combined-guard'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    for (const id of ['http-user-guard', 'http-combined-guard']) {
        const events = result.events.filter(e => e.caseId === id);
        const rejected = events.filter(e => e.kind === 'request-response' && e.status === 'admission_busy');
        expect(rejected).toHaveLength(48);
        const attempts = new Set(rejected.map(e => e.attemptId));
        expect(events.filter(e => e.kind === 'transaction-attempt' && attempts.has(e.attemptId))).toHaveLength(0);
        expect(events.filter(e => e.kind === 'client-response' && ['bob', 'carol'].includes(e.uid) && e.status === 'completed')).toHaveLength(6);
        expect(Math.max(...events.filter(e => e.kind === 'outstanding' && e.uid === 'alice').map(e => e.value))).toBe(2);
    }
    const unguarded = result.events.filter(e => e.caseId === 'http-unguarded');
    expect(Math.max(...unguarded.filter(e => e.kind === 'outstanding' && e.uid === 'alice').map(e => e.value))).toBe(50);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 20000);
test('instance capacity bounds database work across many distinct users', async () => {
    const result = await runHttpExperiment({ cases: ['http-instance-guard'] });
    expect(result.cases[0].status).toBe('complete');
    const replies = result.events.filter(e => e.kind === 'client-response');
    expect(replies.filter(e => e.reason === 'instance_capacity' && e.httpStatus === 503)).toHaveLength(4);
    expect(replies.filter(e => e.status === 'completed')).toHaveLength(16);
    expect(Math.max(...result.events.filter(e => e.kind === 'outstanding').map(e => e.instanceValue))).toBe(16);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 10000);
test('HTTP timeout and disconnect retain capacity until delayed work settles, then allow recovery', async () => {
    const result = await runHttpExperiment({ cases: ['http-timeout-drain', 'http-disconnect-drain'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    for (const id of ['http-timeout-drain', 'http-disconnect-drain']) {
        const events = result.events.filter(e => e.caseId === id);
        const response = name => events.find(e => e.kind === 'client-response' && e.clientAttemptId === name);
        expect(response('retry').status).toBe('admission_busy');
        expect(response('recovered').status).toBe('completed');
        expect(events.filter(e => e.kind === 'inference-dispatch' && e.uid === 'alice').map(e => e.requestId)).toEqual(['recovered']);
        expect(events.filter(e => e.kind === 'request-work-settled' && e.afterDeadline && e.uid === 'alice')).toHaveLength(2);
        const serverTrace = events.filter(e => e.role === 'server').sort((a, b) => a.localSequence - b.localSequence);
        const retry = serverTrace.findIndex(e => e.kind === 'request-response' && e.requestId === 'retry');
        const settlement = serverTrace.findIndex(e => e.kind === 'request-work-settled' && e.afterDeadline);
        expect(settlement).toBeGreaterThan(retry);
    }
    expect(result.events.filter(e => e.caseId === 'http-disconnect-drain' && e.kind === 'client-disconnected')).toHaveLength(2);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 15000);
test('HTTP capture preserves source, process timing, load metrics and replayable assessment', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { captureRun, verifyCapture } = await import('../../../shared/evidence/capture.mjs');
    const { captureDefinition } = await import('../capture-definition.mjs');
    const { compareRuns } = await import('../analysis/assess.mjs');
    const output = await mkdtemp(join(tmpdir(), 'http-allowance-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: {
                profile: 'local', suite: 'http-overload', cases: ['http-timeout-drain'], limits: { maxRequests: 10 },
            } });
        expect(saved.successfulExperiment).toBe(true);
        expect((await verifyCapture(saved.directory)).valid).toBe(true);
        const result = JSON.parse(await readFile(join(saved.directory, 'result.json'), 'utf8'));
        const summary = JSON.parse(await readFile(join(saved.directory, 'summary.json'), 'utf8'));
        expect(result.run.suite).toBe('http-overload');
        expect(summary.http['http-timeout-drain'].clientOutcomes.completed).toBe(7);
        expect(summary.http['http-timeout-drain'].clientOutcomes.admission_timeout).toBe(2);
        expect(summary.http['http-timeout-drain'].peakInstanceAdmission).toBeGreaterThanOrEqual(2);
        expect(summary.http['http-timeout-drain'].peakInstanceAdmission).toBeLessThanOrEqual(16);
        expect(result.events.some(e => e.kind === 'server-resource-sample' && e.rssBytes > 0)).toBe(true);
        expect(result.events.some(e => e.kind === 'server-resource-summary' && e.cpuUserMicros >= 0)).toBe(true);
        expect(result.events.every(e => e.role !== 'server' || typeof e.localElapsedMs === 'number')).toBe(true);
        const replay = await captureRun(output, { sourceCapture: saved.directory });
        expect(replay.successfulExperiment).toBe(true);
        const replayResult = JSON.parse(await readFile(join(replay.directory, 'result.json'), 'utf8'));
        expect(compareRuns(result, replayResult).compatible).toBe(true);
        expect(compareRuns(result, replayResult).performanceComparable).toBe(false);
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
test('HTTP request budgets fail before starting processes', async () => {
    await expect(runHttpExperiment({ cases: ['http-unguarded'], limits: { maxRequests: 55 } })).rejects.toThrow('budget');
    await expect(runHttpExperiment({ cases: ['http-normal'], limits: { maxRequests: 501 } })).rejects.toThrow('budget');
});
test('missing Node executable returns incomplete evidence without hanging cleanup', async () => {
    const previousPath = process.env.PATH;
    let timer;
    try {
        process.env.PATH = '/nonexistent-node-fixture';
        const outcome = await Promise.race([
            runHttpExperiment({ cases: ['http-normal'] }),
            new Promise<Awaited<ReturnType<typeof runHttpExperiment>> | null>(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
        ]);
        expect(outcome).not.toBeNull();
        expect(outcome.cases[0].status).toBe('error');
        expect(outcome.cases[0].error).toContain('ENOENT');
    }
    finally {
        clearTimeout(timer);
        process.env.PATH = previousPath;
    }
}, 4000);
test('instance slots survive disconnected requests and reject a different UID until work settles', async () => {
    const result = await runHttpExperiment({ cases: ['http-instance-drain'] });
    expect(result.cases[0].status).toBe('complete');
    const replies = result.events.filter(e => e.kind === 'client-response');
    expect(replies.find(e => e.clientAttemptId === 'retry')).toMatchObject({ reason: 'instance_capacity', httpStatus: 503 });
    expect(replies.find(e => e.clientAttemptId === 'recovered')).toMatchObject({ status: 'completed', httpStatus: 200 });
    expect(result.assertions.find(a => a.name === 'HTTP status matches outcome')?.passed).toBe(true);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 10000);
test('controller interruption preserves partial HTTP evidence and children exit on IPC loss', async () => {
    const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { captureRun, verifyCapture } = await import('../../../shared/evidence/capture.mjs');
    const { captureDefinition } = await import('../capture-definition.mjs');
    const { compareRuns } = await import('../analysis/assess.mjs');
    const output = await mkdtemp(join(tmpdir(), 'http-interrupted-'));
    const sha = value => createHash('sha256').update(value).digest('hex');
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: {
                profile: 'local', suite: 'http-overload', cases: ['http-timeout-drain'], limits: { maxRequests: 10 },
            } });
        const manifestPath = join(saved.directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const entry = manifest.files.find(file => file.path.endsWith('/execute.mjs'));
        const entryPath = join(saved.directory, entry.path);
        const source = await readFile(entryPath, 'utf8');
        const changed = source.replace('onEvent: event => {', "onEvent: event => { if (event.kind === 'injected-delay-start') setTimeout(() => process.exit(7), 50);");
        expect(changed).not.toBe(source);
        await writeFile(entryPath, changed);
        entry.sha256 = sha(changed);
        entry.bytes = Buffer.byteLength(changed);
        manifest.sourceSnapshotHash = sha(JSON.stringify(manifest.files.filter(file => file.path.startsWith('source/'))));
        await writeFile(manifestPath, JSON.stringify(manifest));
        const interrupted = await captureRun(output, { sourceCapture: saved.directory });
        expect(interrupted.successfulExperiment).toBe(false);
        expect((await verifyCapture(interrupted.directory)).valid).toBe(true);
        const result = JSON.parse(await readFile(join(interrupted.directory, 'result.json'), 'utf8'));
        expect(result.execution.status).toBe('incomplete');
        expect(result.run.suite).toBe('http-overload');
        expect(result.run.selectedCases).toEqual(['http-timeout-drain']);
        expect(result.events.some(e => e.kind === 'injected-delay-start')).toBe(true);
        expect(compareRuns(result, result).compatible).toBe(false);
        const pids = new Set(result.events.filter(e => ['server-ready', 'generator-ready'].includes(e.kind)).map(e => e.processId));
        expect(pids.size).toBe(2);
        for (const pid of pids)
            expect(() => process.kill(Number(pid), 0)).toThrow();
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
