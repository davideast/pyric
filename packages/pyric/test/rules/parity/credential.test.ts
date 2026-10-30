/**
 * Credential selection for the live Rules Test API runs, and the failure
 * contract: a configured credential that cannot mint a token fails the run, an
 * absent credential skips it, and `PARITY_REQUIRE_CREDENTIAL=1` turns that
 * skip into an error. No test here reaches the network: token exchanges go to
 * a server on 127.0.0.1, and the guard below fails any test that starts a
 * child process or sends a request elsewhere through `http`, `https`, or
 * global `fetch`.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { createServer } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CredentialEnvironment,
  DEFAULT_PARITY_PROJECT_ID,
  firebaseToolsConfigPath,
  gcloudAdcPath,
  hasParityCredential,
  parityScope,
  resolveParityCredential,
} from './credential.js';
import { runScenario, type Scenario } from './harness.js';
import { STRESS_SCENARIOS } from '../../../../../packages/conformance/rules-corpus/firestore/index.ts';

const HOME = '/home/dev';

const LOOPBACK = '127.0.0.1';

function requestHost(target: unknown): string {
  if (typeof target === 'string' || target instanceof URL) return new URL(target).hostname;
  if (target instanceof Request) return new URL(target.url).hostname;
  const options = target as { hostname?: string; host?: string } | undefined;
  return options?.hostname ?? options?.host ?? 'localhost';
}

/**
 * Refuses child processes, and requests off loopback through `http`, `https`
 * and global `fetch`. Each refusal is recorded, and the `afterEach` below fails
 * the test that made it, even when the library swallows the error.
 *
 * The child-process refusal is the one that catches a `GoogleAuth` project-id
 * lookup: its first step runs `gcloud config config-helper`. Its later steps
 * go through gaxios, which under Bun uses Bun's built-in `node-fetch`; that
 * path does not pass through anything a test can patch.
 */
function guardNetwork(): { refused: string[]; restore: () => void } {
  const refused: string[] = [];
  const refuse = (what: string): never => {
    refused.push(what);
    throw new Error(`credential.test.ts refused ${what}: tests here stay on loopback`);
  };
  const mutableHttp = http as { request: typeof http.request };
  const mutableHttps = https as { request: typeof https.request };
  const mutableChild = childProcess as { exec: typeof childProcess.exec };
  const original = {
    httpRequest: mutableHttp.request,
    httpsRequest: mutableHttps.request,
    exec: mutableChild.exec,
    fetch: globalThis.fetch,
  };
  mutableHttp.request = ((target: unknown, ...rest: unknown[]) => {
    const host = requestHost(target);
    if (host !== LOOPBACK) refuse(`http request to ${host}`);
    return (original.httpRequest as (...args: unknown[]) => http.ClientRequest)(target, ...rest);
  }) as typeof http.request;
  mutableHttps.request = ((target: unknown) => refuse(`https request to ${requestHost(target)}`)) as typeof https.request;
  // A refused command fails through its callback, the way a missing `gcloud`
  // does, so the library goes on to its next lookup and that is checked too.
  mutableChild.exec = ((command: string, ...rest: unknown[]) => {
    const callback = rest.find((arg) => typeof arg === 'function') as ((error: Error) => void) | undefined;
    try {
      refuse(`child process "${command}"`);
    } catch (error) {
      queueMicrotask(() => callback?.(error as Error));
    }
    return undefined;
  }) as unknown as typeof childProcess.exec;
  globalThis.fetch = Object.assign((target: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = requestHost(target);
    if (host !== LOOPBACK) refuse(`fetch to ${host}`);
    return original.fetch(target, init);
  }, original.fetch);
  return {
    refused,
    restore: () => {
      mutableHttp.request = original.httpRequest;
      mutableHttps.request = original.httpsRequest;
      mutableChild.exec = original.exec;
      globalThis.fetch = original.fetch;
    },
  };
}

const network = guardNetwork();

afterAll(() => {
  network.restore();
});

afterEach(() => {
  expect(network.refused.splice(0)).toEqual([]);
});

function environment(env: Record<string, string>, files: string[] = []): CredentialEnvironment {
  const present = new Set(files);
  return { env, home: HOME, exists: (path) => present.has(path) };
}

describe('resolveParityCredential', () => {
  test('GOOGLE_APPLICATION_CREDENTIALS selects ADC and wins over a firebase-tools login', () => {
    const credential = resolveParityCredential(environment(
      { GOOGLE_APPLICATION_CREDENTIALS: '/runner/gha-creds.json', GOOGLE_CLOUD_PROJECT: 'from-auth-action' },
      [firebaseToolsConfigPath(HOME)],
    ));
    expect(credential).toEqual({ source: 'adc', projectId: 'from-auth-action', origin: 'GOOGLE_APPLICATION_CREDENTIALS' });
  });

  test('the ADC project is PARITY_PROJECT_ID, then GOOGLE_CLOUD_PROJECT, then GCLOUD_PROJECT, then the default', () => {
    const gac = { GOOGLE_APPLICATION_CREDENTIALS: '/c.json' };
    const project = (env: Record<string, string>) => {
      const c = resolveParityCredential(environment({ ...gac, ...env }));
      return c.source === 'adc' ? c.projectId : undefined;
    };
    expect(project({ PARITY_PROJECT_ID: 'p', GOOGLE_CLOUD_PROJECT: 'g', GCLOUD_PROJECT: 'l' })).toBe('p');
    expect(project({ GOOGLE_CLOUD_PROJECT: 'g', GCLOUD_PROJECT: 'l' })).toBe('g');
    expect(project({ GCLOUD_PROJECT: 'l' })).toBe('l');
    expect(project({})).toBe(DEFAULT_PARITY_PROJECT_ID);
  });

  test('a firebase-tools login is used when GOOGLE_APPLICATION_CREDENTIALS is unset', () => {
    const credential = resolveParityCredential(environment(
      { PARITY_PROJECT_ID: 'mine' },
      [firebaseToolsConfigPath(HOME), gcloudAdcPath({}, HOME)],
    ));
    expect(credential).toEqual({ source: 'firebase-tools', projectId: 'mine', configPath: firebaseToolsConfigPath(HOME) });
  });

  test('the gcloud ADC file is used when it is the only source, honoring CLOUDSDK_CONFIG', () => {
    expect(resolveParityCredential(environment({}, [join(HOME, '.config', 'gcloud', 'application_default_credentials.json')])))
      .toEqual({ source: 'adc', projectId: DEFAULT_PARITY_PROJECT_ID, origin: 'gcloud' });
    expect(resolveParityCredential(environment(
      { CLOUDSDK_CONFIG: '/opt/gcloud' },
      ['/opt/gcloud/application_default_credentials.json'],
    ))).toEqual({ source: 'adc', projectId: DEFAULT_PARITY_PROJECT_ID, origin: 'gcloud' });
  });

  test('a base64 service account key in PARITY_SA_BASE64 is not a credential source', () => {
    expect(resolveParityCredential(environment({ PARITY_SA_BASE64: 'e30=' }))).toEqual({ source: 'none' });
  });
});

describe('hasParityCredential', () => {
  test('an absent credential skips', () => {
    expect(hasParityCredential(environment({}))).toBe(false);
  });

  test('an absent credential is an error when PARITY_REQUIRE_CREDENTIAL=1', () => {
    expect(() => hasParityCredential(environment({ PARITY_REQUIRE_CREDENTIAL: '1' })))
      .toThrow('PARITY_REQUIRE_CREDENTIAL=1 is set. No Rules Test API credential found.');
  });

  test('a resolved credential runs whether or not it is required', () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: '/c.json' };
    expect(hasParityCredential(environment(env))).toBe(true);
    expect(hasParityCredential(environment({ ...env, PARITY_REQUIRE_CREDENTIAL: '1' }))).toBe(true);
  });
});

/**
 * Runs `body` with a token exchange (STS) on 127.0.0.1 that answers every
 * request with `token`. `body` gets a writer for an external-account ADC file,
 * the format Workload Identity Federation writes in CI, that exchanges there.
 * Returns the requests the exchange received.
 */
async function withLoopbackSts(
  token: string,
  body: (writeExternalAccount: (path: string) => void) => Promise<void>,
): Promise<string[]> {
  const requests: string[] = [];
  const sts = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: token,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 3600,
    }));
  });
  await new Promise<void>((resolve) => sts.listen(0, LOOPBACK, resolve));
  try {
    const { port } = sts.address() as AddressInfo;
    await body((path) => {
      const subjectToken = `${path}.subject-token`;
      writeFileSync(subjectToken, 'subject');
      writeFileSync(path, JSON.stringify({
        type: 'external_account',
        audience: '//iam.googleapis.com/projects/0/locations/global/workloadIdentityPools/p/providers/p',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: `http://${LOOPBACK}:${port}/v1/token`,
        credential_source: { file: subjectToken },
      }));
    });
  } finally {
    await new Promise<void>((resolve) => sts.close(() => resolve()));
  }
  return requests;
}

describe('an ADC scope mints from the file the resolver chose', () => {
  const saved = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    CLOUDSDK_CONFIG: process.env.CLOUDSDK_CONFIG,
    HOME: process.env.HOME,
  };
  let dir: string | undefined;

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // google-auth-library looks for the gcloud file only under
  // $HOME/.config/gcloud. HOME points at an empty directory here, so a scope
  // that let the library search would find nothing.
  test('the gcloud ADC file under CLOUDSDK_CONFIG', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-credential-'));
    const home = join(dir, 'home');
    const cloudsdkConfig = join(dir, 'gcloud-config');
    mkdirSync(home);
    mkdirSync(cloudsdkConfig);
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.HOME = home;
    process.env.CLOUDSDK_CONFIG = cloudsdkConfig;
    const exchanges = await withLoopbackSts('gcloud-config-token', async (writeExternalAccount) => {
      writeExternalAccount(join(cloudsdkConfig, 'application_default_credentials.json'));
      const credential = resolveParityCredential({ env: process.env, home, exists: existsSync });
      expect(credential).toMatchObject({ source: 'adc', origin: 'gcloud' });
      expect(await parityScope(credential).resolveToken()).toBe('gcloud-config-token');
    });
    expect(exchanges).toEqual(['POST /v1/token']);
  });
});

describe('a configured credential that cannot mint a token fails the run', () => {
  const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let dir: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // In CI a live parity test mints a token from the real Workload Identity
  // Federation file before the cases below run, in the same process. This
  // stands in for it: an external-account file whose token exchange goes to a
  // loopback STS, so a credential mints a token without leaving the machine.
  // The cases after it must still read the file their own environment names.
  test('a credential that minted a token earlier in the process does not answer for a later scope', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-credential-'));
    const file = join(dir, 'external-account.json');
    const exchanges = await withLoopbackSts('loopback-token', async (writeExternalAccount) => {
      writeExternalAccount(file);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
      const scope = parityScope({ source: 'adc', projectId: 'p', origin: 'GOOGLE_APPLICATION_CREDENTIALS' });
      expect(await scope.resolveToken()).toBe('loopback-token');
    });
    expect(exchanges).toEqual(['POST /v1/token']);
  });

  test('an ADC file that does not exist rejects from resolveToken', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-credential-'));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(dir, 'missing.json');
    const scope = parityScope({ source: 'adc', projectId: 'p', origin: 'GOOGLE_APPLICATION_CREDENTIALS' });
    await expect(scope.resolveToken()).rejects.toThrow();
  });

  test('an ADC service account file whose key cannot sign rejects from resolveToken', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-credential-'));
    const file = join(dir, 'broken.json');
    writeFileSync(file, JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      client_email: 'parity@p.iam.gserviceaccount.com',
      private_key: 'not a private key',
    }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
    const scope = parityScope({ source: 'adc', projectId: 'p', origin: 'GOOGLE_APPLICATION_CREDENTIALS' });
    await expect(scope.resolveToken()).rejects.toThrow();
  });

  test('no credential source throws instead of returning a scope', () => {
    expect(() => parityScope({ source: 'none' })).toThrow('No Rules Test API credential found.');
  });

  test('runScenario fails, rather than tallying, when the token exchange is rejected', async () => {
    const scenario: Scenario = STRESS_SCENARIOS[0];
    const scope = {
      projectId: 'p',
      resolveToken: () => Promise.reject(new Error('invalid_grant: Invalid JWT Signature.')),
    };
    await expect(runScenario(scenario, scope))
      .rejects.toThrow(`Production API call failed for scenario "${scenario.id}": FETCH_FAILED invalid_grant`);
  });
});
