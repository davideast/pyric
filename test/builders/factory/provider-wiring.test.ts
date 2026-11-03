// The provider channel wired into a run: the key file, the supervisor's two
// forwarders on one ledger, the cap's timeline and journal lines, what each
// sandbox's environment gets, and that the key reaches no run file. Calls go
// to a fake TLS upstream through the forwarder's upstream seam.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioEnvironment } from './app-start.ts';
import type { Checkout } from './app-paths.ts';
import { parseFactoryOptions } from './options.ts';
import { PLACEHOLDER_KEY, type ProviderUpstream } from './provider-forwarder.ts';
import { providerKeyFileProblem, readProviderKey } from './provider-keys.ts';
import { PROVIDER_PRICES, PROVIDER_HOST } from './provider-prices.ts';
import { capLine, providerFiles, providerSpendLine, startProviderChannel } from './provider-wiring.ts';
import { runPaths } from './run-dir.ts';
import { runScanRoots, scannedSecrets, secretHits } from './secret-scan.ts';
import { mediaEnvironment } from './session-runner.ts';
import type { RunSession, SessionResult } from './session.ts';
import { runSupervisor } from './supervisor.ts';
import { formatSummary } from './summary.ts';
import { readTimeline } from './timeline.ts';

const SENTINEL_KEY = 'sentinel-provider-key-wiring-not-real';
const IMAGE_MODEL = 'gemini-nano-banana-2.1';
const IMAGE_PATH = `/v1beta/models/${IMAGE_MODEL}:generateContent`;
const IMAGE_USD = PROVIDER_PRICES[IMAGE_MODEL]?.usdPerCall ?? 0;
/** Two image calls fit, a third doesn't. */
const TWO_CALL_CAP_USD = Math.round(IMAGE_USD * 2.5 * 100) / 100;

let certDir = '';
let upstream: { port: number; ca: string; received: string[]; close: () => Promise<void> };

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'factory-wiring-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${PROVIDER_HOST}`,
    '-addext', `subjectAltName=DNS:${PROVIDER_HOST}`,
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
  ], { stdio: 'ignore' });
  const cert = readFileSync(join(certDir, 'cert.pem'), 'utf8');
  const key = readFileSync(join(certDir, 'key.pem'), 'utf8');
  const received: string[] = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    received.push(String(request.headers['x-goog-api-key']));
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"candidates":[]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream = {
    port: (server.address() as AddressInfo).port,
    ca: cert,
    received,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
});

afterAll(async () => {
  await upstream.close();
});

const fakeUpstream = (): ProviderUpstream => ({ host: '127.0.0.1', port: upstream.port, tls: true, ca: upstream.ca });

/** A key file outside the run, mode 0600, holding the sentinel among other lines. */
function keyFile(mode = 0o600, dir = mkdtempSync(join(tmpdir(), 'factory-keys-'))): string {
  const path = join(dir, 'provider.env');
  writeFileSync(path, `# provider keys\nOTHER=1\nGEMINI_API_KEY=${SENTINEL_KEY}\n`);
  chmodSync(path, mode);
  return path;
}

function imageCall(socketPath: string): Promise<number> {
  const body = JSON.stringify({ contents: [{ parts: [{ text: 'a lighthouse' }] }] });
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: 'POST', path: IMAGE_PATH, headers: { 'content-type': 'application/json', 'x-goog-api-key': PLACEHOLDER_KEY } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('the key file', () => {
  test('the key comes from its GEMINI_API_KEY line, and a problem never quotes the file', () => {
    expect(readProviderKey(keyFile())).toEqual({ ok: true, key: SENTINEL_KEY });
    const dir = mkdtempSync(join(tmpdir(), 'factory-keys-'));
    writeFileSync(join(dir, 'bad.env'), `OTHER_KEY=${SENTINEL_KEY}\n`, { mode: 0o600 });
    const read = readProviderKey(join(dir, 'bad.env'));
    expect(read.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain(SENTINEL_KEY);
  });

  test('mode 0644, or a file inside the run directory, is refused; 0600 outside is used', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'factory-run-'));
    const app = runPaths(runDir).app;
    expect(providerKeyFileProblem(keyFile(0o644), runDir, app, '/nonexistent-repo')).toContain('mode 0600');
    mkdirSync(join(runDir, 'keys'));
    expect(providerKeyFileProblem(keyFile(0o600, join(runDir, 'keys')), runDir, app, '/nonexistent-repo')).toContain('inside');
    expect(providerKeyFileProblem(keyFile(), runDir, app, '/nonexistent-repo')).toBeUndefined();
  });

  test('--provider-keys is a resolved path; without it the run has none', () => {
    expect(parseFactoryOptions(['--run-dir', '/r', '--hours', '1', '--provider-keys', 'k.env']).providerKeys).toMatch(/\/k\.env$/);
    expect(parseFactoryOptions(['--run-dir', '/r', '--hours', '1']).providerKeys).toBeUndefined();
  });
});

describe('sandbox environments', () => {
  test('without a provider socket a session and Studio keep fake media and get no base URL', () => {
    const checkout = { home: '/h' } as Checkout;
    for (const env of [mediaEnvironment(undefined), studioEnvironment({ checkout })]) {
      expect(env.MDMEDIA_FAKE_MEDIA).toBe('1');
      expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
    }
  });

  test('with one, the app gets the placeholder key and the bridge, never the key, and no fake media', () => {
    const checkout = { home: '/h' } as Checkout;
    for (const env of [mediaEnvironment('/run.host/provider/session.sock'), studioEnvironment({ checkout, provider: true })]) {
      expect(env.MDMEDIA_FAKE_MEDIA).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBe(PLACEHOLDER_KEY);
      expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:4180');
      expect(JSON.stringify(env)).not.toContain(SENTINEL_KEY);
    }
  });
});

describe('the provider channel', () => {
  test('sessions and the served copy share one ledger: the sessions\' sub-cap leaves the served copy its budget', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'factory-run-'));
    const caps: string[] = [];
    const channel = await startProviderChannel({ runDir, keyFile: keyFile(), capUsd: IMAGE_USD * 3.5, sessionCapUsd: IMAGE_USD * 1.5, upstream: fakeUpstream(), onCap: (cap) => caps.push(cap.scope) });
    try {
      expect(await imageCall(channel.socket('session'))).toBe(200);
      expect(await imageCall(channel.socket('session'))).toBe(429);
      expect(await imageCall(channel.socket('session'))).toBe(429);
      expect(await imageCall(channel.socket('served'))).toBe(200);
      expect(await imageCall(channel.socket('served'))).toBe(200);
      expect(await imageCall(channel.socket('served'))).toBe(429);
    } finally {
      await channel.close();
    }
    expect(caps).toEqual(['session', 'run']);
  });
});

describe('a run with --provider-keys', () => {
  test('two calls succeed, the third is refused, one provider-cap line, the run goes on, and the key is in no run file', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'factory-run-'));
    const briefDir = mkdtempSync(join(tmpdir(), 'factory-brief-'));
    const stop = new AbortController();
    const journal: string[] = [];
    const statuses: number[] = [];
    let sessionSockets: Array<string | undefined> = [];
    const before = upstream.received.length;
    const runSession: RunSession = async (_role, options): Promise<SessionResult> => {
      sessionSockets = [...sessionSockets, options.providerSocket];
      const isFirst = sessionSockets.length === 1;
      if (isFirst && options.providerSocket !== undefined) {
        for (let call = 0; call < 4; call += 1) statuses.push(await imageCall(options.providerSocket));
        stop.abort();
      }
      return { exitCode: 0, endedBy: 'exit', logPath: '' };
    };
    const outcome = await runSupervisor({
      runDir, hours: 1, agent: 'fake', briefDir, resume: false, runSession, stop: stop.signal, pid: 1,
      log: (line) => journal.push(line),
      provider: { keyFile: keyFile(), capUsd: TWO_CALL_CAP_USD, sessionCapUsd: TWO_CALL_CAP_USD, upstream: fakeUpstream() },
    });
    expect(outcome).toBe('stopped');
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(upstream.received.slice(before)).toEqual([SENTINEL_KEY, SENTINEL_KEY]);
    expect(sessionSockets[0]).toBe(providerFiles(runDir).socket('session'));
    const timeline = readTimeline(runPaths(runDir).timeline);
    expect(timeline.filter((line) => line.type === 'provider-cap')).toHaveLength(1);
    expect(journal).toContain(`provider spend reached $${TWO_CALL_CAP_USD.toFixed(2)}; provider calls are refused`);
    expect(formatSummary(timeline)).toContain('provider spend reached');
    expect(providerSpendLine(runDir)).toBe(`provider spend $${(IMAGE_USD * 2).toFixed(2)} of $${TWO_CALL_CAP_USD.toFixed(0)} (2 images, 0 music, 2 refused)`);
    const secrets = scannedSecrets([], { ok: false, problem: 'no agent credential in this test' }, readProviderKey(keyFile()));
    expect(secrets).toEqual([SENTINEL_KEY]);
    expect(secretHits(runDir, runScanRoots(runDir), secrets)).toEqual([]);
    expect(journal.join('\n')).not.toContain(SENTINEL_KEY);
  });

  test('the run-wide cap: journal names the run\'s cap', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'factory-run-'));
    const lines: string[] = [];
    const channel = await startProviderChannel({ runDir, keyFile: keyFile(), capUsd: TWO_CALL_CAP_USD, sessionCapUsd: TWO_CALL_CAP_USD, upstream: fakeUpstream(), onCap: (cap) => lines.push(cap.scope) });
    try {
      for (let call = 0; call < 3; call += 1) await imageCall(channel.socket('served'));
    } finally {
      await channel.close();
    }
    expect(lines).toEqual(['run']);

    expect(capLine({ scope: 'run', capUsd: 50 })).toBe('provider spend reached $50.00; provider calls are refused');
  });
});
