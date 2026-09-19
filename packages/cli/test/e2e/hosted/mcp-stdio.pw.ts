import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { CLI_PATH, McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

function stdioMcp(projectDir: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, 'mcp'],
    cwd: projectDir,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'hosted-stdio-fixture', version: '1.0.0' });
  return {
    client,
    transport,
    connect: () => client.connect(transport),
    stderr: () => stderr,
    async close() {
      await client.close();
      await transport.close();
    },
  };
}

test('stdio MCP reads the document written through the normal browser SDK', async ({ browser }) => {
  const serve = await startHostedFixture();
  const mcp = stdioMcp(serve.dir);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await mcp.connect();
    const result = await mcp.client.callTool({
      name: 'firestore_get_document', arguments: { path: 'shared/greeting', as: 'admin' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Hello from the other browser') }]);
  } finally {
    await mcp.close();
    await context.close().finally(() => serve.stop());
  }
});

for (const location of ['subdirectory', 'symlink']) {
  test(`stdio MCP attaches from a project ${location}`, async () => {
    const serve = await startHostedFixture();
    const aliases = mkdtempSync(join(tmpdir(), 'pyric-stdio-alias-'));
    let callerDir = join(serve.dir, 'src');
    const usesSubdirectory = location === 'subdirectory';
    if (usesSubdirectory) {
      mkdirSync(callerDir);
    } else {
      callerDir = join(aliases, 'project');
      symlinkSync(serve.dir, callerDir, 'junction');
    }
    const mcp = stdioMcp(callerDir);
    try {
      const owner = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
      await owner.initialize();
      await expect(owner.toolCall('firestore_create_document', {
        path: 'shared/location', data: { message: 'Read from the same project' }, as: 'admin',
      })).resolves.toMatchObject({ ok: true });
      await mcp.connect();
      const result = await mcp.client.callTool({
        name: 'firestore_get_document', arguments: { path: 'shared/location', as: 'admin' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Read from the same project') }]);
    } finally {
      await mcp.close().finally(() => serve.stop());
      rmSync(aliases, { recursive: true, force: true });
    }
  });
}

test('stdio MCP at a Unicode workspace root discovers the host in its frontend directory', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pyric-stdio-项目-'));
  const frontend = join(workspace, 'web');
  mkdirSync(frontend);
  const host = startHost(frontend);
  const writer = stdioMcp(workspace);
  const reader = stdioMcp(frontend);
  try {
    expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
    await writer.connect();
    const write = await writer.client.callTool({
      name: 'firestore_create_document',
      arguments: { path: 'shared/workspace', data: { message: 'Workspace and frontend share this host' }, as: 'admin' },
    });
    expect(write.isError).not.toBe(true);
    await reader.connect();
    const read = await reader.client.callTool({
      name: 'firestore_get_document', arguments: { path: 'shared/workspace', as: 'admin' },
    });
    expect(read.isError).not.toBe(true);
    expect(read.content).toEqual([{ type: 'text', text: expect.stringContaining('Workspace and frontend share this host') }]);
  } finally {
    await writer.close();
    await reader.close().finally(() => host.stop());
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a copied discovery pointer cannot admit stdio MCP to another project', async () => {
  const serve = await startHostedFixture();
  const foreignProject = mkdtempSync(join(tmpdir(), 'pyric-foreign-stdio-'));
  mkdirSync(join(foreignProject, '.pyric'));
  copyFileSync(join(serve.dir, '.pyric/serve.json'), join(foreignProject, '.pyric/serve.json'));
  const mcp = stdioMcp(foreignProject);
  try {
    await expect(mcp.connect()).rejects.toThrow();
    await expect.poll(mcp.stderr).toContain('another project');
    const owner = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await owner.initialize();
    await expect(owner.toolCall('firestore_create_document', {
      path: 'shared/owner', data: { source: 'original project' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    await expect(owner.toolCall('firestore_get_document', { path: 'shared/owner', as: 'admin' }))
      .resolves.toMatchObject({ ok: true, data: { exists: true, data: { source: 'original project' } } });
  } finally {
    await mcp.close().finally(() => serve.stop());
    rmSync(foreignProject, { recursive: true, force: true });
  }
});

test('stdio MCP refuses a host that restarted after discovery and before initialization', async () => {
  const first = await startHostedFixture();
  const mcp = stdioMcp(first.dir);
  const reply = Promise.withResolvers<JSONRPCMessage>();
  mcp.transport.onmessage = reply.resolve;
  try {
    await mcp.transport.start();
    await expect.poll(mcp.stderr).toContain('relaying stdio');
    const terminated = once(first.child, 'exit');
    first.child.kill('SIGTERM');
    await terminated;
    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await mcp.transport.send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'restart-fixture', version: '1.0.0' } },
      });
      await expect(reply.promise).resolves.toMatchObject({ id: 1, error: { code: -32001 } });
      await expect.poll(mcp.stderr).toContain('instance has changed');
      const fresh = stdioMcp(first.dir);
      try {
        await fresh.connect();
        const tools = await fresh.client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain('firestore_get_document');
      } finally {
        await fresh.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await mcp.close().finally(() => first.stop());
  }
});

for (const failure of [
  { name: 'loses its acknowledgment', closesConnection: true },
  { name: 'never receives its acknowledgment', closesConnection: false },
]) {
  test(`stdio MCP reports an unknown outcome when a committed add ${failure.name}`, async ({ browser }) => {
    const serve = await startHostedFixture();
    const mcp = stdioMcp(serve.dir);
    const context = await browser.newContext();
    let dropNextReply = false;
    const droppedReply = Promise.withResolvers<void>();
    const proxy = createServer((incoming, outgoing) => {
      const dropsReply = dropNextReply && incoming.method === 'POST';
      if (dropsReply) dropNextReply = false;
      const target = new URL(incoming.url ?? '/', serve.info.url);
      const upstream = request(target, {
        method: incoming.method, headers: { ...incoming.headers, host: target.host }, agent: false,
      }, (reply) => {
        if (dropsReply) {
          reply.resume();
          reply.once('end', () => {
            droppedReply.resolve();
            const closesConnection = failure.closesConnection;
            if (closesConnection) outgoing.destroy();
          });
          return;
        }
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(outgoing);
      });
      upstream.on('error', () => outgoing.destroy());
      outgoing.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    });
    try {
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const address = proxy.address();
      const hasNoTcpAddress = address === null || typeof address === 'string';
      if (hasNoTcpAddress) throw new Error('The fault proxy did not bind a TCP address.');
      const pointerPath = join(serve.dir, '.pyric/serve.json');
      const pointer: Record<string, unknown> = JSON.parse(readFileSync(pointerPath, 'utf8'));
      writeFileSync(pointerPath, JSON.stringify({ ...pointer, port: address.port }));
      await mcp.connect();
      await mcp.client.listTools();
      dropNextReply = true;
      const outcome = mcp.client.callTool({
        name: 'firestore_add_document',
        arguments: { collection: 'lost-ack', data: { message: 'Only once' }, as: 'admin' },
      }).then(() => 'Acknowledged', (error: unknown) => {
        const isError = error instanceof Error;
        return isError ? error.message : String(error);
      });
      await droppedReply.promise;
      const errorMessage = await outcome;
      const page = await context.newPage();
      await page.goto(serve.info.url);
      await expect(page.getByRole('button', { name: 'Write shared document' })).toBeEnabled();
      const documents = await page.evaluate(async () => {
        const { collection, getDocs, getFirestore } = await import('firebase/firestore');
        const snapshot = await getDocs(collection(getFirestore(), 'lost-ack'));
        return snapshot.docs.map((document) => document.data());
      });
      expect(documents).toEqual([{ message: 'Only once' }]);
      expect(errorMessage).toContain('outcome is unknown');
      expect(errorMessage).toContain('may have committed');
      expect(errorMessage).not.toContain('— retry');
    } finally {
      await mcp.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await context.close().finally(() => serve.stop());
    }
  });
}
