// The upstream forwarder with the Codex policy, over real sockets, all on this machine: the
// "backend" is a plain-HTTP server on loopback and the login is made up.
// No request leaves the machine, and the record never holds a token.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Listening } from '../../../model-channel.ts';
import type { CredentialRead } from '../../agent.ts';
import { startUpstreamForwarder, type UpstreamEvent } from '../../upstream-forwarder.ts';
import { codexAgent } from './adapter.ts';
import { startFakeChatgpt, type FakeChatgpt } from './fixtures/fake-chatgpt.ts';
import { fakeLogin } from './fixtures/fake-login.ts';
import { codexCredential, type CodexLogin } from './login.ts';

const MODEL = 'gpt-6.1-sol';
const open: Array<Listening | FakeChatgpt> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const signedIn = (login: CodexLogin) => (): CredentialRead => ({ ok: true, credential: codexCredential(login) });

async function setup(credential: () => CredentialRead = signedIn(fakeLogin())) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-forwarder-'));
  const backend = await startFakeChatgpt();
  const socketPath = join(dir, 'f.sock');
  const record = join(dir, 'channel.jsonl');
  const forwarder = await startUpstreamForwarder({ socketPath, record, policy: codexAgent.policy, credential, upstream: { host: '127.0.0.1', port: backend.port, tls: false } });
  open.push(backend, forwarder);
  return { socketPath, record, backend };
}

interface Answer {
  status: number;
  body: string;
}

function post(socketPath: string, path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Answer> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, method, headers: { 'content-type': 'application/json', originator: 'codex_exec', ...headers } }, (response) => {
      let answer = '';
      response.on('data', (chunk) => { answer += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: answer }));
    });
    request.on('error', reject);
    request.end(method === 'GET' ? undefined : text);
  });
}

function lines(record: string): UpstreamEvent[] {
  return readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as UpstreamEvent);
}

function expectNoToken(record: string, login = fakeLogin()): void {
  const text = readFileSync(record, 'utf8');
  for (const secret of login.secrets) expect(text).not.toContain(secret);
  expect(text).not.toContain('made-up-signature');
}

describe('the forwarder with the Codex policy', () => {
  test('puts the login on a turn, replacing whatever the sandbox sent, and streams the answer back', async () => {
    const login = fakeLogin();
    const { socketPath, record, backend } = await setup(signedIn(login));
    const answer = await post(socketPath, '/backend-api/codex/responses', { model: MODEL, input: [] }, { authorization: 'Bearer from-the-sandbox', cookie: 'c' });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('response.completed');
    const received = backend.received[0];
    expect(received?.path).toBe('/backend-api/codex/responses');
    expect(received?.headers.authorization).toBe(`Bearer ${login.accessToken}`);
    expect(received?.headers['chatgpt-account-id']).toBe('made-up-account-id');
    expect(received?.headers.host).toBe('chatgpt.com');
    expect(received?.headers.originator).toBe('codex_exec');
    expect(received?.headers.cookie).toBeUndefined();
    const [line] = lines(record);
    expect(line).toMatchObject({ action: 'forwarded', reason: null, status: 200, model: MODEL, droppedHeaders: ['authorization', 'cookie'] });
    expect(line?.rateLimit).toEqual({ limitReached: false, resetAt: null, usedPercent: { primary: 42 } });
    expectNoToken(record, login);
  });

  test('passes a usage-limit 429 back to Codex and records its reset', async () => {
    const { socketPath, record, backend } = await setup();
    backend.limitedUntil = 1793790664;
    const answer = await post(socketPath, '/backend-api/codex/responses', { model: MODEL });
    expect(answer.status).toBe(429);
    expect(answer.body).toContain('usage_limit_reached');
    expect(lines(record)[0]?.rateLimit).toMatchObject({ limitReached: true, resetAt: '2026-11-04T11:11:04.000Z' });
  });

  test('refuses another path, a GET, another model, a server tool, a remote image and an encoded body, sending nothing on', async () => {
    const { socketPath, record, backend } = await setup();
    expect((await post(socketPath, '/backend-api/codex/models', {})).status).toBe(403);
    expect((await post(socketPath, '/backend-api/codex/responses', {}, {}, 'GET')).status).toBe(403);
    expect((await post(socketPath, '/backend-api/codex/responses', { model: 'gpt-6-astra' })).status).toBe(403);
    expect((await post(socketPath, '/backend-api/codex/responses', { model: MODEL, tools: [{ type: 'web_search' }] })).status).toBe(403);
    const remoteImage = { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://elsewhere.example/x.png' }] }] };
    expect((await post(socketPath, '/backend-api/codex/responses', remoteImage)).status).toBe(403);
    expect((await post(socketPath, '/backend-api/codex/responses', { model: MODEL }, { 'content-encoding': 'zstd' })).status).toBe(415);
    expect(backend.received).toEqual([]);
    expect(lines(record).map((line) => [line.action, line.reason])).toEqual([
      ['refused', 'path'], ['refused', 'method'], ['refused', 'other-model'], ['refused', 'server-tool'], ['refused', 'remote-input'], ['refused', 'encoded-body'],
    ]);
    expect(lines(record)[3]?.refusedNames).toEqual(['web_search']);
  });

  test('refuses with 401 when the login can’t be read or is about to lapse, naming no token', async () => {
    const missing = await setup(() => ({ ok: false, problem: 'the Codex login /x/auth.json does not exist' }));
    const answer = await post(missing.socketPath, '/backend-api/codex/responses', { model: MODEL });
    expect(answer.status).toBe(401);
    expect(answer.body).toContain('does not exist');
    const lapsing = fakeLogin(new Date(Date.now() + 60_000));
    const expired = await setup(signedIn(lapsing));
    const refused = await post(expired.socketPath, '/backend-api/codex/responses', { model: MODEL });
    expect(refused.status).toBe(401);
    expect(lines(expired.record)[0]).toMatchObject({ action: 'refused', reason: 'credential-expired' });
    expect(expired.backend.received).toEqual([]);
    expectNoToken(expired.record, lapsing);
    expect(refused.body).not.toContain(lapsing.accessToken);
  });
});
