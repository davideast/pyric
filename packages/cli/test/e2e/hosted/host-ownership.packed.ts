import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

/** Copy the compiled artifact outside the workspace: it must bring its own runtime and assets. */
function standalone() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-standalone-owner-'));
  const executable = join(dir, 'pyric');
  copyFileSync(new URL('../../../dist-bin/pyric', import.meta.url), executable);
  return { executable, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the standalone executable refuses a project owned by Node', async () => {
  const binary = standalone();
  const first = await startHostedFixture();
  const second = startHost(first.dir, 0, [binary.executable]);
  try {
    expect(await second.startup, second.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(second.stderr()).toContain('already owns this project');
  } finally {
    await second.stop().finally(() => first.stop());
    binary.close();
  }
});

test('standalone in-process MCP owns project state until its transport closes', async () => {
  const binary = standalone();
  const project = mkdtempSync(join(tmpdir(), 'pyric-standalone-in-process-'));
  const transport = new StdioClientTransport({
    command: binary.executable, args: ['mcp', '--in-process'], cwd: project, stderr: 'pipe',
  });
  const client = new Client({ name: 'standalone-in-process-owner', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'firestore' })]));
    const contender = startHost(project);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }
    await client.close();
    await transport.close();
    const replacement = startHost(project);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await replacement.stop();
    }
  } finally {
    await client.close();
    await transport.close();
    rmSync(project, { recursive: true, force: true });
    binary.close();
  }
});

test('the standalone owner serves the normal SDK and excludes Node', async ({ browser }) => {
  const binary = standalone();
  const first = await startHostedFixture();
  const context = await browser.newContext();
  // Keep the fixture's project and public address, replacing its Node process.
  const terminated = new Promise<void>((resolve) => first.child.once('exit', () => resolve()));
  first.child.kill('SIGTERM');
  await terminated;
  const owner = startHost(first.dir, first.info.port, [binary.executable]);
  try {
    expect(await owner.startup, owner.stderr()).toEqual({ kind: 'ready' });
    const contender = startHost(first.dir);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }
    const mcp = new McpHttpClient(`${first.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'The standalone host owns this data' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    const page = await context.newPage();
    await page.goto(first.info.url);
    await expect(page.locator('#document')).toHaveText('The standalone host owns this data');
  } finally {
    await context.close();
    await owner.stop().finally(() => first.stop());
    binary.close();
  }
});

test('standalone stdio MCP binds discovery to its project', async ({ browser }) => {
  const binary = standalone();
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  const foreignProject = mkdtempSync(join(tmpdir(), 'pyric-standalone-foreign-'));
  mkdirSync(join(foreignProject, '.pyric'));
  copyFileSync(join(serve.dir, '.pyric/serve.json'), join(foreignProject, '.pyric/serve.json'));
  const ownerTransport = new StdioClientTransport({
    command: binary.executable, args: ['mcp'], cwd: serve.dir, stderr: 'pipe',
  });
  const foreignTransport = new StdioClientTransport({
    command: binary.executable, args: ['mcp'], cwd: foreignProject, stderr: 'pipe',
  });
  let refusal = '';
  foreignTransport.stderr?.on('data', (chunk: Buffer) => { refusal += chunk.toString(); });
  const owner = new Client({ name: 'standalone-owner', version: '1.0.0' });
  const foreign = new Client({ name: 'standalone-foreign', version: '1.0.0' });
  try {
    await owner.connect(ownerTransport);
    const write = await owner.callTool({
      name: 'firestore_create_document',
      arguments: { path: 'shared/greeting', data: { message: 'Written through standalone stdio' }, as: 'admin' },
    });
    expect(write.isError).not.toBe(true);
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Written through standalone stdio');
    await expect(foreign.connect(foreignTransport)).rejects.toThrow();
    await expect.poll(() => refusal).toContain('another project');
  } finally {
    await owner.close();
    await foreign.close();
    await ownerTransport.close();
    await foreignTransport.close();
    await context.close().finally(() => serve.stop());
    rmSync(foreignProject, { recursive: true, force: true });
    binary.close();
  }
});
