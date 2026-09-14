import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

function stdioMcp(projectDir: string, flags: readonly string[] = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, 'mcp', ...flags],
    cwd: projectDir,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'state-owner-fixture', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return {
    client,
    connect: () => client.connect(transport),
    stderr: () => stderr,
    async close() {
      await client.close();
      await transport.close();
    },
  };
}

test('MCP discovery failure cannot open a second sandbox in an occupied project', async ({ browser }) => {
  const host = await startHostedFixture();
  const mcp = stdioMcp(host.dir);
  const page = await browser.newPage();
  try {
    await page.goto(host.info.url);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    unlinkSync(join(host.dir, '.pyric', 'serve.json'));

    await expect(mcp.connect()).rejects.toThrow();
    await expect.poll(mcp.stderr).toContain('already owns this project');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    await mcp.close();
    await page.close();
    await host.stop();
  }
});

test('an in-process MCP owner excludes hosted startup and releases state after graceful shutdown', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-in-process-owner-'));
  const owner = stdioMcp(project, ['--in-process']);
  try {
    await owner.connect();
    const write = await owner.client.callTool({
      name: 'firestore',
      arguments: { method: 'setDoc', args: { path: 'shared/value', data: { message: 'Saved by MCP' } } },
    });
    expect(write.isError).not.toBe(true);
    const contender = startHost(project);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }
    await owner.close();
    const replacement = stdioMcp(project, ['--in-process']);
    try {
      await replacement.connect();
      const read = await replacement.client.callTool({
        name: 'firestore', arguments: { method: 'getDoc', args: { path: 'shared/value' } },
      });
      expect(read.isError).not.toBe(true);
      expect(read.content).toEqual([{ type: 'text', text: expect.stringContaining('Saved by MCP') }]);
    } finally {
      await replacement.close();
    }
    const host = startHost(project);
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await host.stop();
    }
  } finally {
    await owner.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('an in-process MCP startup failure releases its project ownership', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-in-process-startup-'));
  const failed = stdioMcp(project, ['--in-process', '--surface', 'missing-test-surface']);
  try {
    await expect(failed.connect()).rejects.toThrow();
    const corrected = stdioMcp(project, ['--in-process']);
    try {
      await corrected.connect();
      const tools = await corrected.client.listTools();
      expect(tools.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'firestore' })]));
    } finally {
      await corrected.close();
    }
  } finally {
    await failed.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('a service CLI mutation cannot compete with an in-process MCP owner', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-mcp-cli-owner-'));
  const owner = stdioMcp(project, ['--in-process']);
  try {
    await owner.connect();
    const write = await owner.client.callTool({
      name: 'firestore',
      arguments: { method: 'setDoc', args: { path: 'shared/value', data: { message: 'Owner value' } } },
    });
    expect(write.isError).not.toBe(true);
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/value',
      '--data', '{"message":"Competing CLI value"}', '--in-process', '--json',
    ], { cwd: project, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('already owns this project'),
      killed: false,
    });
    const read = await owner.client.callTool({
      name: 'firestore', arguments: { method: 'getDoc', args: { path: 'shared/value' } },
    });
    expect(read.isError).not.toBe(true);
    expect(read.content).toEqual([{ type: 'text', text: expect.stringContaining('Owner value') }]);

    await owner.close();
    await promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/value',
      '--data', '{"message":"CLI after shutdown"}', '--in-process', '--json',
    ], { cwd: project, timeout: 10_000 });
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'getDoc', '--path', 'shared/value', '--in-process', '--json',
    ], { cwd: project, timeout: 10_000 })).resolves.toMatchObject({
      stdout: expect.stringContaining('CLI after shutdown'),
    });
  } finally {
    await owner.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('the selected MCP project directory determines ownership independently of the caller directory', async () => {
  const host = await startHostedFixture();
  const caller = mkdtempSync(join(tmpdir(), 'pyric-mcp-selected-project-'));
  symlinkSync(host.dir, join(caller, 'selected'), 'junction');
  const competing = stdioMcp(caller, ['--in-process', '--project-dir', 'selected']);
  const independent = stdioMcp(caller, ['--in-process', '--project-dir', 'independent']);
  try {
    await expect(competing.connect()).rejects.toThrow();
    await expect.poll(competing.stderr).toContain('already owns this project');
    await independent.connect();
    const write = await independent.client.callTool({
      name: 'firestore',
      arguments: { method: 'setDoc', args: { path: 'shared/independent', data: { message: 'Separate project' } } },
    });
    expect(write.isError).not.toBe(true);
  } finally {
    await competing.close();
    await independent.close();
    await host.stop();
    rmSync(caller, { recursive: true, force: true });
  }
});
