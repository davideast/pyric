/**
 * End-to-end CLI (`pyric sandbox events --detail`) and in-process MCP
 * (`sandbox.events`) parity for denial metadata, payload redaction, expired
 * evidence, and method description pointers.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox, type LocalSandbox, type OperationRecord } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';

import { runInProcessMcp } from '../../../../../src/bridge/server/in-process.js';
import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
import { methodByKey } from '../../../../../src/bridge/surface/methods/registry.js';
import { parseArgs } from '../../../../../src/cli/parse-args.js';
import { argumentsFromFlags } from '../../../../../src/cli/surface-method-args.js';
import { runSurfaceMethod } from '../../../../../src/cli/surface-method-runner.js';
import { HOSTED_METHOD_PATH } from '../../../../../src/serve/hosted/method-protocol.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
      allow write: if request.auth != null && request.auth.uid == request.resource.data.owner;
    }
  }
}`;

type DetailedRecord = OperationRecord & {
  request?: unknown;
  resourceBefore?: unknown;
  resourceAfter?: unknown;
};

const sdkSurface = renderSurface(undefined);

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDetailedRecord(value: unknown): value is DetailedRecord {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.service === 'string' &&
    typeof value.method === 'string' &&
    isObjectRecord(value.rules)
  );
}

function eventsFromData(data: unknown): DetailedRecord[] {
  if (!isObjectRecord(data) || !Array.isArray(data.events)) {
    throw new Error('Expected events array in result data');
  }
  const out: DetailedRecord[] = [];
  for (const item of data.events) {
    if (!isDetailedRecord(item)) {
      throw new Error('Unexpected non-record item in events payload');
    }
    out.push(item);
  }
  return out;
}

function eventsFromResult(result: OperationResult): DetailedRecord[] {
  expect(result.ok).toBe(true);
  return eventsFromData(result.data);
}

function eventsFromJsonEnvelope(jsonText: string): DetailedRecord[] {
  const parsed: unknown = JSON.parse(jsonText);
  if (!isObjectRecord(parsed)) {
    throw new Error('Expected JSON object envelope');
  }
  return eventsFromData(parsed.data);
}

function parseHostedCallBody(rawText: string): { key: string; args: Record<string, unknown> } {
  const parsed: unknown = JSON.parse(rawText);
  if (!isObjectRecord(parsed) || typeof parsed.key !== 'string' || !isObjectRecord(parsed.args)) {
    throw new Error('Expected hosted call body with key and args');
  }
  return { key: parsed.key, args: parsed.args };
}

function firstMcpText(result: unknown): string {
  if (!isObjectRecord(result) || !Array.isArray(result.content)) {
    throw new Error('Expected MCP result content array');
  }
  const first: unknown = result.content[0];
  if (!isObjectRecord(first) || typeof first.text !== 'string') {
    throw new Error('Expected text content in MCP result');
  }
  return first.text;
}

async function runSdk(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = sdkSurface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

function assertNoPayloads(records: readonly DetailedRecord[]): void {
  for (const record of records) {
    expect('request' in record).toBe(false);
    expect('resourceBefore' in record).toBe(false);
    expect('resourceAfter' in record).toBe(false);
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-events-cli-mcp-parity-'));
  sandbox = initializeSandbox();
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('sandbox events CLI, MCP, and metadata parity', () => {
  it('supports CLI --detail and MCP sandbox.events parity with default payload redaction', async () => {
    const cliDir = mkdtempSync(join(tmpdir(), 'pyric-cli-events-detail-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'pyric-cli-events-home-'));
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      writeFileSync(join(cliDir, 'firestore.rules'), FIRESTORE_RULES);
      writeFileSync(
        join(cliDir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
      );

      const eventsMethod = methodByKey('sandbox.events');
      expect(
        argumentsFromFlags(
          eventsMethod,
          parseArgs(['sandbox', 'events', '--kind', 'denials', '--detail']),
        ),
      ).toEqual({ args: { kind: 'denials', detail: true } });
      expect(
        argumentsFromFlags(eventsMethod, parseArgs(['sandbox', 'events', '--detail', 'false'])),
      ).toEqual({ args: { detail: false } });

      // 1. CLI `pyric sandbox events` against a hosted loopback endpoint carrying a planted denial.
      const hostedSandbox = initializeSandbox();
      setRules(hostedSandbox, FIRESTORE_RULES);
      seedDocuments(hostedSandbox, { 'items/item-1': { owner: 'user-1', secret: 'cli-private' } });
      await setDoc(doc(getFirestore(hostedSandbox.withAuth({ uid: 'user-2' })), 'items/item-1'), {
        owner: 'user-1',
        secret: 'cli-candidate',
      }).catch(() => undefined);
      const hostedCtx = createSurfaceContext(hostedSandbox, cliDir);
      const server = createServer((req, res) => {
        if (req.url !== HOSTED_METHOD_PATH || req.method !== 'POST') {
          res.statusCode = 404;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = parseHostedCallBody(Buffer.concat(chunks).toString('utf8'));
          void methodByKey(body.key)
            .handler(body.args, hostedCtx)
            .then((result) => {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(result));
            });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected TCP address from ephemeral loopback server');
      }
      const host = {
        url: `http://127.0.0.1:${address.port}`,
        mcpUrl: `http://127.0.0.1:${address.port}/__pyric/mcp`,
        base: `http://127.0.0.1:${address.port}`,
        instanceId: 'test-instance',
        source: 'pointer .pyric/serve.json',
      };
      const runCliEvents = async (argv: string[]): Promise<DetailedRecord[]> => {
        let out = '';
        const code = await runSurfaceMethod('sandbox.events', parseArgs(argv), {
          cwd: cliDir,
          stdout: { write: (chunk) => { out += chunk; } },
          stderr: { write: () => {} },
          discover: async () => host,
        });
        expect(code).toBe(0);
        return eventsFromJsonEnvelope(out);
      };
      try {
        const cliDefaultEvents = await runCliEvents(['sandbox', 'events', '--kind', 'denials', '--json']);
        expect(cliDefaultEvents).toHaveLength(1);
        const firstCliDefault = requireDefined(cliDefaultEvents[0], 'first CLI default event');
        expect(firstCliDefault.denial?.reasons.length).toBeGreaterThan(0);
        expect(firstCliDefault.denial?.rule?.expression).toBe(
          'request.auth != null && request.auth.uid == request.resource.data.owner',
        );
        assertNoPayloads(cliDefaultEvents);

        const cliDetailEvents = await runCliEvents([
          'sandbox',
          'events',
          '--kind',
          'denials',
          '--detail',
          '--json',
        ]);
        const firstCliDetail = requireDefined(cliDetailEvents[0], 'first CLI detail event');
        expect(firstCliDetail.request).toMatchObject({
          resourceData: { owner: 'user-1', secret: 'cli-candidate' },
        });
        expect(firstCliDetail.resourceBefore).toMatchObject({
          exists: true,
          data: { owner: 'user-1', secret: 'cli-private' },
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // 2. Real MCP client over InMemoryTransport (`runInProcessMcp`).
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const serverDone = runInProcessMcp(cliDir, {
        env: { ...process.env, HOME: homeDir },
        transport: serverTransport,
      });
      const client = new Client({ name: 'events-denial-parity', version: '0' });
      await client.connect(clientTransport);
      const callMcpText = async (
        name: string,
        method: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        const res = await client.callTool({ name, arguments: { method, args } });
        return firstMcpText(res);
      };
      try {
        await callMcpText('sandbox', 'seed', {
          firestore: { 'items/item-1': { owner: 'user-1', secret: 'mcp-private' } },
        });
        await callMcpText('auth', 'impersonate', { uid: 'user-2' });
        await callMcpText('firestore', 'setDoc', {
          path: 'items/item-1',
          data: { owner: 'user-1', secret: 'mcp-candidate' },
        });

        const mcpDefaultEvents = eventsFromJsonEnvelope(
          await callMcpText('sandbox', 'events', { kind: 'denials' }),
        );
        expect(mcpDefaultEvents).toHaveLength(1);
        const firstMcpDefault = requireDefined(mcpDefaultEvents[0], 'first MCP default event');
        expect(firstMcpDefault.denial?.rule?.expression).toBe(
          'request.auth != null && request.auth.uid == request.resource.data.owner',
        );
        assertNoPayloads(mcpDefaultEvents);

        const mcpDetailEvents = eventsFromJsonEnvelope(
          await callMcpText('sandbox', 'events', { kind: 'denials', detail: true }),
        );
        const firstMcpDetail = requireDefined(mcpDetailEvents[0], 'first MCP detail event');
        expect(firstMcpDetail.request).toMatchObject({
          resourceData: { owner: 'user-1', secret: 'mcp-candidate' },
        });
        expect(firstMcpDetail.resourceBefore).toMatchObject({
          exists: true,
          data: { owner: 'user-1', secret: 'mcp-private' },
        });
      } finally {
        await client.close();
        await serverDone;
      }
    } finally {
      process.env.HOME = priorHome;
      rmSync(cliDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('surfaces evidenceExpired on sandbox.events and points to pyric serve denials in its description', async () => {
    setRules(sandbox, FIRESTORE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'user-1' } });
    const deniedDb = getFirestore(sandbox.withAuth({ uid: 'user-2' }));
    const allowedDb = getFirestore(sandbox.withAuth({ uid: 'user-1' }));

    await getDoc(doc(deniedDb, 'items/item-1')).catch(() => undefined);
    for (let i = 0; i < 65; i++) {
      await getDoc(doc(allowedDb, 'items/item-1'));
    }

    const events = eventsFromResult(await runSdk('sandbox.events', { kind: 'denials' }));
    const first = requireDefined(events[0], 'first expired denial event');
    expect(first.denial?.evidenceExpired).toBe(true);
    expect(first.denial?.reasons.length).toBeGreaterThan(0);

    const eventsMethod = methodByKey('sandbox.events');
    expect(eventsMethod.description).toContain('pyric serve denials');
    expect(eventsMethod.signature).toContain('detail?');
  });
});
