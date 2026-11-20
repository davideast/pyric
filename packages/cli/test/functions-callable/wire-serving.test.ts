/**
 * Local wire-protocol verification for callable `onCall` serving on
 * `pyric sandbox --hosted`: runs the unchanged `functions-callable` capture
 * fixture (`firebase.json`, `fixture/index.cjs`, `public/`) and verifies every
 * wire probe contract against `firebase-functions 7.2.5` and `pyric-admin`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  callableBody,
  functionsCallableCaptureDir,
  functionsCallableProbes,
  reportOf,
  sendProbe,
  sendProbeRequest,
  type AppCheckTokenKind,
  type AuthTokenKind,
  type CallableProbeRequest,
  type FunctionsCallableWireProbe,
  type ProbeTargets,
} from '@pyric/conformance/functions-callable-fixture';
import { mintAppCheckToken, mintIdToken } from 'pyric/sandbox/internal';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const PROJECT_ID = 'demo-functions-callable';
const REGION = 'us-central1';
const APP_ID = '1:000000000000:web:0000000000000000';
const TEST_UID = 'callable-wire-user';

interface HostedPlane {
  cwd: string;
  url: string;
  command: ChildProcess;
  targets: ProbeTargets;
  output(): string;
}

let hostedPlane: Promise<HostedPlane> | undefined;

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

function functionPath(name: string, region = REGION): string {
  return `/${PROJECT_ID}/${region}/${name}`;
}

function stageFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-callable-wire-'));
  cpSync(join(functionsCallableCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsCallableCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsCallableCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  return cwd;
}

async function startHostedPlane(): Promise<HostedPlane> {
  if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
  const cwd = stageFixture();
  let output = '';
  const command = spawn(
    'node',
    [cliEntry, 'sandbox', '--hosted', '--no-run', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
    {
      cwd,
      env: {
        ...process.env,
        FIREBASE_DEBUG_MODE: 'true',
        FIREBASE_DEBUG_FEATURES: '{"skipTokenVerification":true}',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  command.stdout?.setEncoding('utf8');
  command.stderr?.setEncoding('utf8');
  command.stdout?.on('data', (chunk: string) => { output += chunk; });
  command.stderr?.on('data', (chunk: string) => { output += chunk; });

  const pointer = await waitFor(() => {
    const path = join(cwd, '.pyric/serve.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as { url: string };
  }, 15_000);
  if (!pointer) throw new Error(`pyric sandbox --hosted did not start:\n${output}`);
  const url = pointer.url.replace(/\/$/, '');

  const ready = await waitFor(async () => {
    const response = await sendProbeRequest(`${url}${functionPath('pyricCallableEcho')}`, {
      id: 'ready',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      clientTimeoutMs: 2_000,
      ...callableBody({}),
    });
    if (response.status === 200) return true;
    return null;
  }, 30_000);
  if (!ready) throw new Error(`callable child did not answer 200:\n${output}`);

  return {
    cwd,
    url,
    command,
    output: () => output,
    targets: {
      functionBase: (region) => `${url}/${PROJECT_ID}/${region}`,
      runBase: (name, region) => `${url}${functionPath(name, region)}`,
      hostingBase: () => url,
    },
  };
}

function session(): Promise<HostedPlane> {
  if (hostedPlane === undefined) {
    hostedPlane = startHostedPlane();
  }
  return hostedPlane;
}

function freshValidIdToken(projectId = PROJECT_ID): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return mintIdToken({
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    auth_time: nowSec,
    user_id: TEST_UID,
    sub: TEST_UID,
    iat: nowSec,
    exp: nowSec + 3600,
    firebase: { identities: {}, sign_in_provider: 'custom' },
  });
}

function expiredIdToken(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return mintIdToken({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: nowSec - 7200,
    user_id: TEST_UID,
    sub: TEST_UID,
    iat: nowSec - 7200,
    exp: nowSec - 3600,
    firebase: { identities: {}, sign_in_provider: 'custom' },
  });
}

function forgedToken(token: string): string {
  const parts = token.split('.');
  const header = parts[0] ?? '';
  const payload = parts[1] ?? '';
  const signature = parts[2] ?? '';
  let replacement = 'A';
  if (signature.at(-1) === 'A') replacement = 'B';
  return `${header}.${payload}.${signature.slice(0, -1)}${replacement}`;
}

function authHeader(kind: AuthTokenKind): string {
  if (kind === 'garbage') return 'Bearer not-a-jwt';
  if (kind === 'basic') return `Basic ${Buffer.from('pyric:callable').toString('base64')}`;
  const valid = freshValidIdToken();
  if (kind === 'forged') return `Bearer ${forgedToken(valid)}`;
  if (kind === 'expired') return `Bearer ${expiredIdToken()}`;
  return `Bearer ${valid}`;
}

async function appCheckHeader(
  kind: AppCheckTokenKind,
  sharedLimited: () => Promise<string>,
  sharedValid: () => Promise<string>,
): Promise<string> {
  if (kind === 'invalid') {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'not-an-app' })).toString('base64url');
    return `${header}.${body}.`;
  }
  if (kind === 'limited-use-shared') return sharedLimited();
  if (kind === 'limited-use') {
    const minted = await mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 300);
    return minted.token;
  }
  return sharedValid();
}

async function withMintedTokens(requests: readonly CallableProbeRequest[]): Promise<CallableProbeRequest[]> {
  let limitedPromise: Promise<string> | undefined;
  let validPromise: Promise<string> | undefined;
  const sharedLimited = (): Promise<string> => {
    if (limitedPromise === undefined) {
      limitedPromise = mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 300).then((m) => m.token);
    }
    return limitedPromise;
  };
  const sharedValid = (): Promise<string> => {
    if (validPromise === undefined) {
      validPromise = mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 3600).then((m) => m.token);
    }
    return validPromise;
  };

  const out: CallableProbeRequest[] = [];
  for (const req of requests) {
    const headers = { ...req.headers };
    if (req.tokens?.auth) headers.authorization = authHeader(req.tokens.auth);
    if (req.tokens?.appCheck) {
      headers['x-firebase-appcheck'] = await appCheckHeader(req.tokens.appCheck, sharedLimited, sharedValid);
    }
    out.push({ ...req, headers });
  }
  return out;
}

function wireProbe(name: string): FunctionsCallableWireProbe {
  const found = functionsCallableProbes.find(
    (probe): probe is FunctionsCallableWireProbe => probe.kind === 'wire' && probe.name === name,
  );
  if (!found) throw new Error(`missing wire probe ${name}`);
  return found;
}

afterAll(async () => {
  const started = await hostedPlane?.catch(() => undefined);
  const cliPid = started?.command.pid;
  let children: number[] = [];
  if (cliPid !== undefined) {
    children = functionsChildrenOf(cliPid);
  }
  if (started && started.command.exitCode === null) {
    started.command.kill('SIGKILL');
  }
  for (const pid of children) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  if (started) {
    rmSync(started.cwd, { recursive: true, force: true });
  }
});

type ParsedFrame =
  | { kind: 'data'; json: unknown }
  | { kind: 'comment'; text: string };

function parseSseFrames(body: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const rawBlock of body.split(/\n\n/)) {
    const block = rawBlock.trim();
    if (block.length === 0) continue;
    if (block.startsWith(':')) {
      frames.push({ kind: 'comment', text: block.slice(1).trim() });
    } else if (block.startsWith('data: ')) {
      frames.push({ kind: 'data', json: JSON.parse(block.slice('data: '.length)) });
    }
  }
  return frames;
}

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing response ${label}`);
  return value;
}

describe('callable wire serving on pyric sandbox --hosted', () => {
  test('serves data roundtrip, encoding, HttpsError codes, plain throws, and request validation', async () => {
    const { targets } = await session();

    const roundtrip = await sendProbe(wireProbe('functions-callable-data-roundtrip').requests, targets);
    expect(roundtrip['return-null']?.json).toEqual({ result: null });
    expect(roundtrip['return-undefined']?.json).toEqual({ result: null });
    expect(reportOf(must(roundtrip['sent-object'], 'sent-object'))?.data).toEqual({ a: 1, nested: { b: [true, 'x'] } });

    const encoding = await sendProbe(wireProbe('functions-callable-encoding').requests, targets);
    expect(reportOf(must(encoding.int64, 'int64'))?.data).toBe(9007199254740992);
    expect(encoding['return-date']?.json).toEqual({ result: {} });
    expect(encoding['return-nan']?.status).toBe(500);
    expect(encoding['return-infinity']?.status).toBe(500);

    const errors = await sendProbe(wireProbe('functions-callable-https-error-codes').requests, targets);
    expect(errors.ok?.status).toBe(200);
    expect(errors['invalid-argument']?.status).toBe(400);
    expect(errors['not-found']?.status).toBe(404);
    expect(errors.unauthenticated?.status).toBe(401);
    expect(errors['unknown-code']?.status).toBe(500);

    const plainThrows = await sendProbe(wireProbe('functions-callable-plain-throw').requests, targets);
    for (const res of Object.values(plainThrows)) {
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: { message: 'INTERNAL', status: 'INTERNAL' } });
    }

    const badReq = await sendProbe(wireProbe('functions-callable-bad-request').requests, targets);
    for (const key of ['get', 'put', 'text-plain', 'no-body', 'missing-data', 'extra-keys']) {
      expect(badReq[key]?.status).toBe(400);
      expect(badReq[key]?.json).toEqual({ error: { message: 'Bad Request', status: 'INVALID_ARGUMENT' } });
    }
    expect(badReq['malformed-json']?.status).toBe(400);
    expect(badReq.charset?.status).toBe(200);
    expect(badReq['data-null']?.status).toBe(200);
  }, 60_000);

  test('verifies valid, missing, forged, wrong-audience, and expired ID tokens even if host sets FIREBASE_DEBUG_MODE', async () => {
    const { targets } = await session();

    const valid = await sendProbe(await withMintedTokens(wireProbe('functions-callable-auth-valid').requests), targets);
    expect(reportOf(must(valid.v2, 'valid.v2'))?.auth).toMatchObject({
      present: true,
      keys: ['rawToken', 'token', 'uid'],
      uidMatchesSub: true,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
    });
    expect(reportOf(must(valid.v1, 'valid.v1'))?.auth.present).toBe(true);

    const missing = await sendProbe(wireProbe('functions-callable-auth-missing').requests, targets);
    expect(reportOf(must(missing.v2, 'missing.v2'))?.auth).toEqual({ present: false });
    expect(reportOf(must(missing.v1, 'missing.v1'))?.auth).toEqual({ present: false });

    const invalid = await sendProbe(await withMintedTokens(wireProbe('functions-callable-auth-invalid').requests), targets);
    for (const res of Object.values(invalid)) {
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' } });
    }

    const wrongAudience = freshValidIdToken('other-project');
    for (const fn of ['pyricCallableEcho', 'pyricCallableV1']) {
      const res = await sendProbeRequest(`${targets.functionBase(REGION)}/${fn}`, {
        id: fn,
        function: fn,
        via: 'cloudfunctions',
        ...callableBody({}),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongAudience}` },
      });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' } });
    }

    const expired = await withMintedTokens(['pyricCallableEcho', 'pyricCallableV1'].map((fn) => ({
      id: fn,
      function: fn,
      via: 'cloudfunctions' as const,
      tokens: { auth: 'expired' as const },
      ...callableBody({}),
    })));
    const expiredRes = await sendProbe(expired, targets);
    for (const res of Object.values(expiredRes)) {
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' } });
    }
  }, 60_000);

  test('verifies App Check enforcement, consumption, CORS, v1, streaming, Hosting rewrite, and execution lines', async () => {
    const { targets, url, output } = await session();

    const enforced = await sendProbe(
      await withMintedTokens(wireProbe('functions-callable-app-check-enforced').requests),
      targets,
    );
    expect(enforced.missing?.status).toBe(401);
    expect(enforced.invalid?.status).toBe(401);
    expect(enforced.valid?.status).toBe(200);
    expect(reportOf(must(enforced.valid, 'enforced.valid'))?.app).toMatchObject({ present: true, appIdPresent: true });

    const unenforced = await sendProbe(
      await withMintedTokens(wireProbe('functions-callable-app-check-unenforced').requests),
      targets,
    );
    expect(reportOf(must(unenforced.invalid, 'unenforced.invalid'))?.app).toEqual({ present: false });
    expect(reportOf(must(unenforced.valid, 'unenforced.valid'))?.app.present).toBe(true);

    const consume = await sendProbe(
      await withMintedTokens(wireProbe('functions-callable-app-check-consume').requests),
      targets,
    );
    expect(reportOf(must(consume['limited-first'], 'limited-first'))?.app.alreadyConsumed).toBe(false);
    expect(reportOf(must(consume['limited-second'], 'limited-second'))?.app.alreadyConsumed).toBe(true);

    const corsLinesBefore = output().split('\n').filter((line) => line.includes('pyricCallableEcho') && line.includes('callable')).length;
    const cors = await sendProbe(wireProbe('functions-callable-cors').requests, targets);
    expect(cors['v2-preflight']?.status).toBe(204);
    expect(cors['v2-preflight']?.headers['access-control-allow-origin']).toBe('https://any-app.example');
    expect(cors['v2-post']?.status).toBe(200);
    expect(cors['v2-post']?.headers['access-control-allow-origin']).toBe('https://any-app.example');
    await Bun.sleep(100);
    const corsLinesAfter = output().split('\n').filter((line) => line.includes('pyricCallableEcho') && line.includes('callable')).length;
    // Only the POST logs a callable execution line; the OPTIONS preflight does not.
    expect(corsLinesAfter - corsLinesBefore).toBe(1);

    const v1Res = await sendProbe(wireProbe('functions-callable-v1').requests, targets);
    expect(v1Res.call?.status).toBe(200);
    expect(v1Res['event-stream']?.status).toBe(400);

    const rewrite = await sendProbe(wireProbe('functions-callable-hosting-rewrite').requests, targets);
    expect(rewrite.call?.status).toBe(200);
    expect(rewrite['https-error']?.status).toBe(400);
    expect(rewrite.get?.status).toBe(400);

    const streamBefore = output().split('\n').filter((line) => line.includes('pyricCallableStream') && line.includes('callable')).length;
    const streamRes = await sendProbe(wireProbe('functions-callable-streaming').requests, targets);
    const frames = parseSseFrames(must(streamRes.stream, 'stream').body);
    expect(frames.some((f) => f.kind === 'comment' && f.text === 'ping')).toBe(true);
    expect(frames.filter((f) => f.kind === 'data').map((f) => f.json)).toEqual([
      { message: 'one' },
      { message: 'two' },
      { message: 'three' },
      { result: { acceptsStreaming: true, sendChunkResults: [true, true, true], signalAborted: false } },
    ]);
    const errorFrames = parseSseFrames(must(streamRes['stream-error'], 'stream-error').body);
    expect(errorFrames.filter((f) => f.kind === 'data').map((f) => f.json)).toEqual([
      { message: 'one' },
      {
        error: {
          details: { after: 1 },
          message: 'stream failed after one chunk',
          status: 'FAILED_PRECONDITION',
        },
      },
    ]);
    expect(streamRes['no-accept']?.json).toEqual({
      result: { acceptsStreaming: false, sendChunkResults: [false, false, false], signalAborted: false },
    });
    await Bun.sleep(200);
    const streamAfter = output().split('\n').filter((line) => line.includes('pyricCallableStream') && line.includes('callable')).length;
    expect(streamAfter - streamBefore).toBe(4);
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
  }, 60_000);
});
