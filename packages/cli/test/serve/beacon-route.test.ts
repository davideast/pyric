/**
 * `POST /__pyric/beacon`, the host half of the interception handshake.
 *
 * A pyric-launched child posts one beacon here the moment its register module
 * finishes installing the hooks and the net-guard. The dev server records it
 * (so the warn-only watchdog knows the child is interlocked) and prints one
 * confirmation line.
 *
 * The route is reachable from any page the developer has open, so the tests
 * below cover both halves of its contract: what it refuses (a browser-shaped
 * request, a wrong or missing token, a non-JSON content type, an oversized
 * body) and what it accepts (a token-bearing local POST, always answered 204
 * even when the body is malformed, because a child must never fail on its own
 * proof-of-life).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { BEACON_BODY_LIMIT_BYTES, formatBeaconReceipt } from '../../src/serve/beacon-route.js';
import { startStaticServer, silentServeLogger, type ServeHandle } from '../../src/serve/server.js';
import { BEACON_TOKEN_HEADER, type BeaconReport } from '../../src/register/beacon.js';

const TOKEN = 'launch-secret-token';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-beacon-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return { site, sdk };
}

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

async function startServe(beacon?: (report: BeaconReport) => void): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    beacon,
    beaconToken: TOKEN,
    logger: silentServeLogger(),
  });
  const h = await startStaticServer({
    publicDir: site,
    port: 0,
    host: '127.0.0.1',
    portScanLimit: 200,
    logger: silentServeLogger(),
    namespaceHandler: ns,
  });
  handles.push(h);
  return h;
}

const body = (over: Partial<BeaconReport> = {}): string =>
  JSON.stringify({
    pid: 9911,
    guard: 'warn',
    hooks: true,
    sandbox: 'remote:http://127.0.0.1:3473',
    ...over,
  });

/** What an activated child sends. */
function post(
  url: string,
  init: { headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return fetch(`${url}/__pyric/beacon`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [BEACON_TOKEN_HEADER]: TOKEN,
      ...init.headers,
    },
    body: init.body ?? body(),
  });
}

describe('/__pyric/beacon accepts an activated child', () => {
  it('204s and hands the parsed report to the callback', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await post(h.url);
    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pid: 9911, guard: 'warn', hooks: true });
  });

  it('204s for a malformed body without calling the callback', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await post(h.url, { body: 'not json' });
    expect(res.status).toBe(204);
    expect(seen).toEqual([]);
  });

  it('204s even with no beacon callback wired', async () => {
    const h = await startServe(undefined);
    expect((await post(h.url)).status).toBe(204);
  });
});

describe('/__pyric/beacon refuses everything else', () => {
  it('rejects non-POST with 405', async () => {
    const h = await startServe(() => {});
    expect((await fetch(`${h.url}/__pyric/beacon`)).status).toBe(405);
  });

  it('rejects a missing token with 401', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await fetch(`${h.url}/__pyric/beacon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(),
    });
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('rejects a wrong token with 401', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await post(h.url, { headers: { [BEACON_TOKEN_HEADER]: 'guessed-wrong-token' } });
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('rejects a non-JSON content type with 415, before the token is even read', async () => {
    const h = await startServe(() => {});
    const res = await post(h.url, { headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(415);
  });

  it('rejects a request carrying an Origin header with 403', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await post(h.url, { headers: { origin: 'https://attacker.example' } });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('rejects a request marked Sec-Fetch-Mode: cors with 403', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await post(h.url, { headers: { 'sec-fetch-mode': 'cors' } });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('rejects an oversized body with 413 rather than buffering it', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const padding = 'x'.repeat(BEACON_BODY_LIMIT_BYTES * 4);
    const res = await post(h.url, { body: body({ sandbox: padding }) });
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('answers no CORS preflight, so a page cannot send the JSON content type', async () => {
    const h = await startServe(() => {});
    const res = await fetch(`${h.url}/__pyric/beacon`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('formatBeaconReceipt', () => {
  it('confirms the interlock with the child pid and guard mode', () => {
    const line = formatBeaconReceipt({
      pid: 9911,
      guard: 'block',
      hooks: true,
      sandbox: 'remote:http://127.0.0.1:3473',
    });
    expect(line).toContain('interlock');
    expect(line).toContain('9911');
    expect(line).toContain('guard=block');
  });

  it('flags a beacon whose hooks did not install', () => {
    const line = formatBeaconReceipt({
      pid: 9911,
      guard: 'warn',
      hooks: false,
      sandbox: 'remote:http://127.0.0.1:3473',
    });
    expect(line).toContain('⚠');
    expect(line).toContain('hooks');
  });
});
