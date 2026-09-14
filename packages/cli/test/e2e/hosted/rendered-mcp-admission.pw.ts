import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';

test('rendered MCP refuses an oversized call before replacing a document', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-rendered-admission-'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI_PATH, 'mcp', '--in-process'], cwd: project, stderr: 'pipe',
  });
  const client = new Client({ name: 'rendered-admission', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    await expect(client.callTool({ name: 'firestore', arguments: {
      method: 'setDoc', args: { path: 'limit/document', data: { message: 'Original' } },
    } })).resolves.toMatchObject({ isError: false });
    const oversized = await client.callTool({ name: 'firestore', arguments: {
      method: 'setDoc', args: { path: 'limit/document', data: { message: 'é'.repeat(13 * 1024 * 1024) } },
    } });
    expect(oversized, stderr).toMatchObject({
      isError: true, content: [{ type: 'text', text: expect.stringContaining('resource-exhausted') }],
    });
    const restored = await client.callTool({ name: 'firestore', arguments: {
      method: 'getDoc', args: { path: 'limit/document' },
    } });
    expect(restored).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('Original') }] });
    await expect(client.callTool({ name: 'firestore', arguments: {
      method: 'setDoc', args: { path: 'limit/healthy', data: { message: 'Healthy' } },
    } })).resolves.toMatchObject({ isError: false });
  } finally {
    await client.close().finally(() => transport.close()).finally(() => rmSync(project, { recursive: true, force: true }));
  }
});

for (const completion of ['success', 'failure']) {
  test(`rendered MCP releases pending capacity after ${completion}`, async () => {
    const project = mkdtempSync(join(tmpdir(), 'pyric-rendered-capacity-'));
    const preload = join(project, 'hold-storage-read.mjs');
    const failsFirstReads = completion === 'failure';
    writeHeldStorageReadPreload(preload, failsFirstReads);
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', preload, CLI_PATH, 'mcp', '--in-process'],
      cwd: project, stderr: 'pipe',
    });
    const client = new Client({ name: 'rendered-capacity', version: '1' });
    let stderr = '';
    let holding = true;
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    try {
      await client.connect(transport);
      const pid = transport.pid;
      const hasNoProcess = pid === null;
      if (hasNoProcess) throw new Error('The MCP fixture has no child process.');
      await expect(client.callTool({ name: 'storage', arguments: { method: 'uploadBytes', args: {
        path: 'held/note.txt', contentBase64: 'eA==', metadata: { contentType: 'application/x-pyric-held' },
      } } })).resolves.toMatchObject({ isError: false });
      for (const round of [0, 1]) {
        const rearmsReads = round === 1;
        if (rearmsReads) {
          process.kill(pid, 'SIGUSR2');
          holding = true;
          await expect.poll(() => stderr).toContain('ARMED\n');
        }
        const accepted = Array.from({ length: 256 }, () => client.callTool({ name: 'storage', arguments: {
          method: 'getBytes', args: { path: 'held/note.txt' },
        } }).catch((error: unknown) => ({ isError: true, error: String(error) })));
        await expect.poll(() => stderr.split('\n').filter(line => line === 'HELD').length).toBe((round + 1) * 256);
        await expect(client.callTool({ name: 'firestore', arguments: {
          method: 'setDoc', args: { path: 'limit/refused', data: { value: 'Must not be written' } },
        } })).resolves.toMatchObject({
          isError: true, content: [{ type: 'text', text: expect.stringContaining('256 pending operations') }],
        });
        // Protocol discovery remains usable while operation admission is full.
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        process.kill(pid, 'SIGUSR2');
        holding = false;
        const expectsFailure = failsFirstReads && round === 0;
        for (const result of await Promise.all(accepted)) expect(result.isError).toBe(expectsFailure);
        await expect(client.callTool({ name: 'firestore', arguments: {
          method: 'getDoc', args: { path: 'limit/refused' },
        } })).resolves.toMatchObject({
          isError: false, content: [{ type: 'text', text: expect.stringContaining('"exists": false') }],
        });
      }
    } finally {
      const pid = transport.pid;
      const releasesHeldReads = holding && pid !== null;
      if (releasesHeldReads) process.kill(pid, 'SIGUSR2');
      await client.close().finally(() => transport.close()).finally(() => rmSync(project, { recursive: true, force: true }));
    }
  });
}
