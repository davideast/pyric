import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumArgs, HOST_RESOLVER_RULES, playwrightClient, stopBrowserChild } from './browser-server.ts';
import { browserRecordIncomplete, readNetworkRecord } from './recorder/network-record.ts';

describe('chromiumArgs', () => {
  test('writes the NetLog where asked and resolves only loopback', () => {
    expect(chromiumArgs('/run/x/chromium-netlog.json')).toEqual([
      '--log-net-log=/run/x/chromium-netlog.json',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ]);
  });

  test('maps every host to not-found and excludes nothing but localhost and 127.0.0.1', () => {
    const rules = HOST_RESOLVER_RULES.split(',').map((rule) => rule.trim());
    expect(rules[0]).toBe('MAP * ~NOTFOUND');
    expect(rules.slice(1)).toEqual(['EXCLUDE localhost', 'EXCLUDE 127.0.0.1']);
  });
});

/** A child standing in for the browser server: it exits when its stdin closes, or never. */
function serverChild(exitsOnStdinEnd: boolean) {
  const onEnd = exitsOnStdinEnd ? 'process.exit(0)' : '';
  return spawn('node', ['-e', `process.stdin.on('end', () => { ${onEnd} }); process.stdin.resume(); setInterval(() => {}, 1000);`], { stdio: ['pipe', 'ignore', 'ignore'] });
}

function emptyRecord(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'builders-browser-stop-')), 'network.jsonl');
  writeFileSync(path, '');
  return path;
}

describe('stopBrowserChild', () => {
  test('leaves no marker when the server stops in time', async () => {
    const networkLog = emptyRecord();
    const result = await stopBrowserChild(serverChild(true), { networkLog, timeoutMs: 10_000, log: () => {} });
    expect(result).toEqual({ killed: false });
    expect(readNetworkRecord(networkLog)).toEqual([]);
  });

  test('kills a server that outlasts its stop and marks the browser record incomplete', async () => {
    const networkLog = emptyRecord();
    const lines: string[] = [];
    const child = serverChild(false);
    const result = await stopBrowserChild(child, { networkLog, timeoutMs: 200, log: (line) => lines.push(line) });
    expect(result).toEqual({ killed: true });
    expect(child.signalCode).toBe('SIGKILL');
    const record = readNetworkRecord(networkLog);
    expect(record).toEqual([expect.objectContaining({ layer: 'browser', kind: 'incomplete', via: 'browser-server' })]);
    expect(browserRecordIncomplete(record)).toBe(true);
    expect(lines.join('\n')).toContain('was killed');
  });
});

describe('playwrightClient', () => {
  test('names an entry whose dynamic import has chromium.connect, as a builder imports it', async () => {
    const client = (await import(playwrightClient())) as { chromium?: { connect?: unknown } };
    expect(playwrightClient()).toEndWith('.mjs');
    expect(typeof client.chromium?.connect).toBe('function');
  });
});
