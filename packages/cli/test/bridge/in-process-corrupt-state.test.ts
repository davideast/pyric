/**
 * Fail-closed corrupt-state handling tests for in-process MCP persistence.
 *
 * Covers truncated JSON, empty files, malformed bundles, unsupported versions,
 * corrupt bucket checksums, CLI startup exit codes, and host-stop fallback
 * preservation of corrupt `.pyric/state/in-process.json`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  IN_PROCESS_STATE_RELATIVE,
  loadSandboxSnapshot,
  runInProcessMcp,
  saveSandboxSnapshot,
} from '../../src/bridge/server/in-process.js';
import type { Discovered } from '../../src/serve/discovery.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

function createProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-corrupt-inproc-')));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
  );
  writeFileSync(
    join(dir, 'firestore.rules'),
    "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /items/{id} { allow read, write: if true; } } }",
  );
  return dir;
}

function writeRawState(projectDir: string, content: string): string {
  const statePath = join(projectDir, IN_PROCESS_STATE_RELATIVE);
  mkdirSync(join(projectDir, '.pyric', 'state'), { recursive: true });
  writeFileSync(statePath, content);
  return statePath;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadSandboxSnapshot fail-closed decoding', () => {
  it('returns null when the state file does not exist and restores valid bundles', () => {
    const dir = createProject();
    const fresh = initializeSandbox();
    expect(loadSandboxSnapshot(fresh, dir)).toBeNull();

    fresh.admin.setDocument('items/1', { title: 'kept' });
    saveSandboxSnapshot(fresh, dir);

    const restored = initializeSandbox();
    expect(loadSandboxSnapshot(restored, dir)).toBe(1);
    expect(restored.admin.getDocument('items/1')).toEqual({ title: 'kept' });
  });

  it('throws on truncated JSON without echoing private payload snippets', () => {
    const dir = createProject();
    const secretMarker = 'private-secret-token-value-999';
    writeRawState(dir, `{"version":4,"records":{"f0":{"docs":{"items/1":{"secret":"${secretMarker}"`);

    const sandbox = initializeSandbox();
    let caught: Error | null = null;
    try {
      loadSandboxSnapshot(sandbox, dir);
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain('not valid JSON');
    expect(caught?.message).not.toContain(secretMarker);
  });

  it('throws on empty JSON objects, unsupported versions, and checksum mismatches', () => {
    const dir = createProject();

    writeRawState(dir, '{}');
    expect(() => loadSandboxSnapshot(initializeSandbox(), dir)).toThrow(/corrupt or unsupported/i);

    writeRawState(
      dir,
      JSON.stringify({
        version: 99,
        records: { meta: { version: 99, savedAt: 0, bucketCount: 0, checksum: 'bad' } },
      }),
    );
    expect(() => loadSandboxSnapshot(initializeSandbox(), dir)).toThrow(/corrupt or unsupported/i);

    // Produce a valid snapshot, then tamper with its bucket payload so checksum fails.
    const good = initializeSandbox();
    good.admin.setDocument('items/a', { count: 1 });
    saveSandboxSnapshot(good, dir);
    const statePath = join(dir, IN_PROCESS_STATE_RELATIVE);
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as {
      version: number;
      records: Record<string, unknown>;
    };
    const bucketKey = Object.keys(parsed.records).find((key) => key !== 'meta');
    expect(bucketKey).toBeDefined();
    if (bucketKey !== undefined) {
      const bucket = parsed.records[bucketKey] as { docs: Record<string, unknown>; checksum?: number };
      bucket.docs['items/a'] = { count: 999 };
    }
    writeFileSync(statePath, JSON.stringify(parsed));
    let mismatchError: Error | null = null;
    try {
      loadSandboxSnapshot(initializeSandbox(), dir);
    } catch (error) {
      if (error instanceof Error) mismatchError = error;
      else mismatchError = new Error(String(error));
    }
    expect(mismatchError).not.toBeNull();
    expect(mismatchError?.message).toMatch(/corrupt or unsupported/i);
    expect(mismatchError?.message).toContain('pyric sandbox salvage --source');
    expect(mismatchError?.message).toContain(join(dir, '.pyric', 'state'));
    expect(mismatchError?.message).toContain('will not overwrite');
  });
});

describe('runInProcessMcp startup and fallback on corrupt state file', () => {
  it('exits non-zero on startup and leaves a truncated state file untouched', async () => {
    const dir = createProject();
    const corruptPayload = '{"version":4,"records":{"meta":{"version":4';
    const statePath = writeRawState(dir, corruptPayload);

    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    let exitCode = -1;
    try {
      exitCode = await runInProcessMcp(dir, {
        transport: serverTransport,
        inProcessOnly: true,
        projectDir: dir,
      });
    } finally {
      process.stderr.write = origWrite;
    }

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('not valid JSON');
    expect(readFileSync(statePath, 'utf8')).toBe(corruptPayload);
  });

  it('runs ephemerally on host-stop fallback and never overwrites a corrupt state file', async () => {
    const dir = createProject();
    const corruptPayload = '{"version":4,"records":{"meta":broken';
    const statePath = writeRawState(dir, corruptPayload);

    const instanceId = 'mock-host-corrupt-fallback';
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__pyric/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'sandbox', instanceId }));
        return;
      }
      if (url.pathname === '/__pyric/hosted/method' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, summary: 'host ok', data: {} }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (addr === null || typeof addr !== 'object') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${addr.port}`;
    const initialHost: Discovered = {
      pointerProjectDir: dir,
      mcpUrl: `${base}/__pyric/mcp`,
      url: base,
      base,
      instanceId,
      source: 'test',
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const exitPromise = runInProcessMcp(dir, {
      transport: serverTransport,
      projectDir: dir,
      initialHost,
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);

    // Stop the mock host: first call detects stop, second falls back to in-process.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await client.callTool({
      name: 'firestore',
      arguments: { method: 'setDoc', args: { path: 'items/detect-stop', data: { v: 0 } } },
    });

    const res = await client.callTool({
      name: 'firestore',
      arguments: { method: 'setDoc', args: { path: 'items/after-fallback', data: { v: 1 } } },
    });
    const text = JSON.stringify(res);
    expect(text).toContain('will not overwrite');

    await client.close();
    await exitPromise;

    expect(readFileSync(statePath, 'utf8')).toBe(corruptPayload);
  });
});
