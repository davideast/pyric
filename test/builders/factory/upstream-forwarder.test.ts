// The upstream forwarder's own rules, with the made-up agent's policy: the
// headers it sends on, what it names when it drops one, and a header Node
// would refuse to send, which is refused rather than thrown.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Listening } from '../model-channel.ts';
import type { CredentialRead } from './agent.ts';
import { FAKE_PATH, fakeAgent, fakeCredential } from './fixtures/fake-agent.ts';
import { startFakeUpstream, type FakeUpstream } from './fixtures/fake-upstream.ts';
import { droppedHeaderNames, forwardedHeaders, startUpstreamForwarder, unsendableHeaders, type UpstreamEvent } from './upstream-forwarder.ts';

const policy = fakeAgent().policy;
const open: Array<Listening | FakeUpstream> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('headers', () => {
  test('sends on the allowlisted headers, then the hop’s own, then the credential’s, which nothing the agent sent replaces', () => {
    const headers = forwardedHeaders({ 'content-type': 'application/json', 'x-fake-turn': '1', authorization: 'Bearer from-the-sandbox', cookie: 'c' }, policy, fakeCredential.headers, 12);
    const authorization = fakeCredential.headers.authorization;
    if (authorization === undefined) throw new Error('the made-up credential sets no authorization header');
    expect(headers).toEqual({ 'content-type': 'application/json', 'x-fake-turn': '1', host: 'upstream.invalid', 'content-length': '12', authorization });
  });

  test('names what it drops, never a value, and not the hop’s own headers', () => {
    expect(droppedHeaderNames({ 'content-type': 'a', host: 'h', connection: 'close', authorization: 'Bearer x', cookie: 'c' }, policy)).toEqual(['authorization', 'cookie']);
  });

  test('names a header Node would refuse to send', () => {
    expect(unsendableHeaders({ ok: 'fine', 'x-bad': 'line\nbreak', 'bad name': 'v' })).toEqual(['x-bad', 'bad name']);
  });
});

function post(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: FAKE_PATH, method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model: 'fake-model' }));
  });
}

describe('the forwarder', () => {
  test('refuses a credential whose header can’t be sent, naming the header and not its value, and keeps serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-forwarder-'));
    const upstream = await startFakeUpstream();
    const record = join(dir, 'channel.jsonl');
    let credential: CredentialRead = { ok: true, credential: { ...fakeCredential, headers: { authorization: 'Bearer made-up\nInjected: yes' } } };
    const faults: string[] = [];
    const forwarder = await startUpstreamForwarder({
      socketPath: join(dir, 'f.sock'), record, policy, credential: () => credential,
      upstream: { host: '127.0.0.1', port: upstream.port, tls: false }, onFault: (reason) => faults.push(reason),
    });
    open.push(upstream, forwarder);
    expect(await post(join(dir, 'f.sock'))).toBe(400);
    credential = { ok: true, credential: fakeCredential };
    expect(await post(join(dir, 'f.sock'))).toBe(200);
    const lines = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as UpstreamEvent);
    expect(lines.map((line) => [line.action, line.reason, line.refusedNames])).toEqual([['refused', 'bad-header', ['authorization']], ['forwarded', null, []]]);
    expect(readFileSync(record, 'utf8')).not.toContain('made-up');
    expect(upstream.received).toHaveLength(1);
    expect(faults).toEqual([]);
  });
});
