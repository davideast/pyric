/**
 * TA.4-A/B — `POST /__pyric/beacon`, the host half of the handshake.
 *
 * A pyric-launched child posts one beacon here the moment its register module
 * finishes installing the hooks and the net-guard. The dev server records it
 * (so the warn-only watchdog knows the child is interlocked) and prints one
 * confirmation line.
 *
 * Like `/__pyric/denials` this is a best-effort diagnostics side channel: it
 * always 204s, even for a malformed body, because a child must never be able
 * to fail on its own proof-of-life.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, formatBeaconReceipt } from '../../src/serve/namespace.js';
import { startStaticServer, silentServeLogger, type ServeHandle } from '../../src/serve/server.js';
import type { BeaconReport } from '../../src/register/beacon.js';

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

async function startServe(
  beacon?: (report: BeaconReport) => void,
): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    beacon,
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

describe('/__pyric/beacon', () => {
  it('204s and hands the parsed report to the callback', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await fetch(`${h.url}/__pyric/beacon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(),
    });
    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pid: 9911, guard: 'warn', hooks: true });
  });

  it('204s for a malformed body without calling the callback', async () => {
    const seen: BeaconReport[] = [];
    const h = await startServe((report) => seen.push(report));
    const res = await fetch(`${h.url}/__pyric/beacon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(204);
    expect(seen).toEqual([]);
  });

  it('rejects non-POST with 405', async () => {
    const h = await startServe(() => {});
    const res = await fetch(`${h.url}/__pyric/beacon`);
    expect(res.status).toBe(405);
  });

  it('204s even with no beacon callback wired', async () => {
    const h = await startServe(undefined);
    const res = await fetch(`${h.url}/__pyric/beacon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(),
    });
    expect(res.status).toBe(204);
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
