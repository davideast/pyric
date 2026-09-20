import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('hosted load-generator dispatch records identify the trace actually sent over HTTP', async () => {
    const requests: { path: string | undefined; trace: string | string[] | undefined }[] = [];
    const server = createServer((req, res) => {
        requests.push({ path: req.url, trace: req.headers['x-cloud-trace-context'] });
        req.resume(); res.setHeader('content-type', 'application/json'); res.end('{"status":"completed"}');
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const child = fork(fileURLToPath(new URL('../harness/http-load-generator.mjs', import.meta.url)), [], { execPath: 'node', silent: true });
    const events: any[] = [];
    child.on('message', message => events.push(message));
    child.stdout?.resume(); child.stderr?.resume();
    try {
        const exited = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Generator exited ${code}`)));
        });
        child.send({ schedule: [{ id: 'trace-test', requestId: 'request-one', uid: 'alice', atMs: 0 }], remote: { url: `http://127.0.0.1:${address.port}`, prefix: '/cases/trace-case' } });
        await exited;
        const dispatch = events.find(event => event.kind === 'client-dispatch').data;
        expect(dispatch.traceId).toMatch(/^[a-f0-9]{32}$/);
        expect(dispatch.requestId).toBe('request-one');
        expect(dispatch.requestPath).toBe('/cases/trace-case/infer/chat');
        expect(requests).toEqual([{ path: dispatch.requestPath, trace: `${dispatch.traceId}/1;o=1` }]);
    } finally {
        child.kill();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
