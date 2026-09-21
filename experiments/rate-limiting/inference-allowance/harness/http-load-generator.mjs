import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { childRecorder, finishChild } from './http-child.mjs';
const record = childRecorder('client');
process.once('message', async ({ port, schedule, remote }) => {
    record('generator-ready', { runtime: 'node', nodeVersion: process.version });
    let transport = request;
    let target = { hostname:'127.0.0.1', port };
    let prefix = '';
    if (remote) {
        const url = new URL(remote.url);
        if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new Error('HTTPS target required');
        if (url.protocol === 'https:') transport = secureRequest;
        target = {hostname:url.hostname, port:url.port || undefined};
        prefix = remote.prefix;
    }
    const acknowledgements = [];
    const acknowledge = (clientAttemptId, index) => {
        acknowledgements.push(new Promise(resolve => {
            const headers = {'content-type':'application/json'};
            if (remote?.token) headers.authorization = `Bearer ${remote.token}`;
            const ack = transport({ ...target, path:prefix+'/observations/chunk', method:'POST', headers }, res => { res.resume(); res.on('end', resolve); });
            ack.on('error', error => { record('client-ack-error', { clientAttemptId, error:error.message }); resolve(); });
            ack.setTimeout(1000, () => ack.destroy(new Error('ack_timeout')));
            ack.end(JSON.stringify({ clientAttemptId, index }));
        }));
    };
    const start = performance.now();
    await Promise.all(schedule.map(item => new Promise(resolve => {
        setTimeout(() => {
            const dispatched = performance.now();
            const traceId=randomUUID().replaceAll('-','');
            const requestPath=prefix+(item.operation==='cancel'?'/cancel':'/infer/chat');
            record('client-dispatch', { clientAttemptId: item.id, requestId: item.requestId ?? item.id, uid: item.uid, traceId, requestPath,
                scheduledMs: item.atMs, actualMs: dispatched - start, schedulerLagMs: dispatched - start - item.atMs });
            let finished = false, disconnectTimer;
            const finish = (kind, data) => {
                if (finished)
                    return;
                finished = true;
                clearTimeout(disconnectTimer);
                record(kind, { clientAttemptId: item.id, uid: item.uid, durationMs: performance.now() - dispatched, ...data });
                resolve();
            };
            const headers = { 'content-type': 'application/json', authorization: `Bearer ${item.token ?? `${item.uid}-token`}`, 'x-experiment-attempt': item.id, 'x-cloud-trace-context': traceId+'/1;o=1' };
            if (item.stream) headers.accept = 'application/x-ndjson';
            if (remote) {
                headers['X-Experiment-User'] = item.uid;
                delete headers.authorization;
                if (remote.token) headers.authorization = `Bearer ${remote.token}`;
            }
            const req = transport({ ...target, path: requestPath, method: 'POST', agent: false,
                headers }, res => {
                let text = '', buffer = '', terminal;
                const streamed = res.headers['content-type']?.includes('application/x-ndjson') ?? false;
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    if (!streamed) { text += chunk; return; }
                    buffer += chunk;
                    let newline;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                        try {
                            const event = JSON.parse(line);
                            if (event.type === 'chunk') {
                                acknowledge(item.id, event.index);
                                record('client-chunk', { clientAttemptId: item.id, uid: item.uid, index: event.index, durationMs: performance.now() - dispatched });
                                if (item.disconnectOnChunk && !finished) {
                                    finish('client-disconnected', { reason: 'disconnect-after-first-chunk' }); req.destroy();
                                }
                            } else if (event.type === 'result') terminal = event;
                        } catch { finish('client-error', { error: 'invalid-stream-response' }); req.destroy(); }
                    }
                });
                res.on('end', () => {
                    try {
                        if (streamed && !terminal) throw new Error('missing stream result');
                        let result = terminal;
                        if (!streamed) result = JSON.parse(text);
                        finish('client-response', { httpStatus: res.statusCode, streamed, ...result });
                    }
                    catch {
                        finish('client-error', { error: 'invalid-json-response' });
                    }
                });
                res.on('error', error => finish('client-error', { error: error.message }));
            });
            if (item.disconnectMs !== undefined)
                disconnectTimer = setTimeout(() => {
                    finish('client-disconnected', { reason: 'scheduled-disconnect' });
                    req.destroy();
                }, item.disconnectMs);
            req.setTimeout(10000, () => req.destroy(new Error('client_timeout')));
            req.on('error', error => finish('client-error', { error: error.message }));
            let body = item.body;
            const bodyMissing = body === undefined || body === null;
            if (bodyMissing && item.operation === 'cancel') body = { requestId: item.requestId };
            else if (bodyMissing) body = { requestId: item.requestId ?? item.id, model: 'test-model', prompt: 'synthetic load' };
            req.end(JSON.stringify(body));
        }, item.atMs);
    })));
    await Promise.all(acknowledgements);
    finishChild({ type: 'done' });
});
