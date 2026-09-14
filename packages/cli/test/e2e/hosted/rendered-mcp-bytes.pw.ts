import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';

const operationBytes = 786_432;

function downloadWithBytes(bytes: number) {
  const call = { name: 'manage_storage_files', arguments: { action: 'download', path: 'held/note.txt' } };
  const overhead = Buffer.byteLength(JSON.stringify(call));
  // Storage references normalize leading separators to the same existing object.
  call.arguments.path = '/'.repeat(bytes - overhead) + call.arguments.path;
  expect(Buffer.byteLength(JSON.stringify(call))).toBe(bytes);
  return call;
}

const scenarios = [
  { boundary: -1, failsReads: false },
  { boundary: 0, failsReads: false },
  { boundary: 1, failsReads: false },
  { boundary: 0, failsReads: true },
];

for (const { boundary, failsReads } of scenarios) {
  test(`rendered MCP enforces aggregate bytes at 24 MiB ${boundary}, failing reads: ${failsReads}`, async () => {
    const project = mkdtempSync(join(tmpdir(), 'pyric-rendered-bytes-'));
    const preload = join(project, 'hold-storage-read.mjs');
    writeHeldStorageReadPreload(preload, failsReads);
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', preload, CLI_PATH, 'mcp', '--in-process', '--surface', 'discriminator'],
      cwd: project, stderr: 'pipe',
    });
    const client = new Client({ name: 'rendered-bytes', version: '1' });
    let stderr = '';
    let holding = true;
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    try {
      await client.connect(transport);
      const pid = transport.pid;
      const hasNoProcess = pid === null;
      if (hasNoProcess) throw new Error('The MCP fixture has no child process.');
      await expect(client.callTool({ name: 'manage_storage_files', arguments: {
        action: 'upload', path: 'held/note.txt', base64Content: 'eA==', contentType: 'application/x-pyric-held',
      } })).resolves.toMatchObject({ isError: false });
      const call = downloadWithBytes(operationBytes);
      const accepted: ReturnType<Client['callTool']>[] = [];
      // Stage writes at the platform-read barrier without flooding stdio's drain callbacks.
      for (const groupSize of [8, 8, 8, 7]) {
        accepted.push(...Array.from({ length: groupSize }, () => client.callTool(call)));
        await expect.poll(() => stderr.split('\n').filter(line => line === 'HELD').length).toBe(accepted.length);
      }
      const last = client.callTool(downloadWithBytes(operationBytes + boundary));
      const exceedsLimit = boundary === 1;
      if (exceedsLimit) {
        await expect(last).resolves.toMatchObject({
          isError: true, content: [{ text: expect.stringContaining('24 MiB queued operation byte limit') }],
        });
        accepted.push(client.callTool(call));
      } else {
        accepted.push(last);
      }
      await expect.poll(() => stderr.split('\n').filter(line => line === 'HELD').length).toBe(32);
      await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('24 MiB queued operation byte limit') }],
      });
      // Release one real operation while its 31 siblings still occupy their bytes.
      process.kill(pid, 'SIGUSR1');
      await expect(accepted[0]).resolves.toMatchObject({ isError: failsReads });
      await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('"ok": true') }],
      });
      const replacement = client.callTool(call);
      await expect.poll(() => stderr.split('\n').filter(line => line === 'HELD').length).toBe(33);
      await expect(client.callTool({ name: 'mutate_sandbox_data', arguments: {
        service: 'firestore', action: 'set', path: 'limit/refused', dataJson: '{"value":"Must not be written"}',
      } })).resolves.toMatchObject({
        isError: true, content: [{ text: expect.stringContaining('24 MiB queued operation byte limit') }],
      });
      process.kill(pid, 'SIGUSR2');
      holding = false;
      for (const result of await Promise.all([...accepted, replacement])) expect(result.isError).toBe(failsReads);
      await expect(client.readResource({ uri: 'pyric://firestore/docs/limit/refused' })).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('"exists": false') }],
      });
      process.kill(pid, 'SIGUSR2');
      holding = true;
      await expect.poll(() => stderr).toContain('ARMED\n');
      const refilled: ReturnType<Client['callTool']>[] = [];
      for (const groupSize of [8, 8, 8, 8]) {
        refilled.push(...Array.from({ length: groupSize }, () => client.callTool(call)));
        await expect.poll(() => stderr.split('\n').filter(line => line === 'HELD').length).toBe(33 + refilled.length);
      }
      await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('24 MiB queued operation byte limit') }],
      });
      process.kill(pid, 'SIGUSR2');
      holding = false;
      for (const result of await Promise.all(refilled)) expect(result.isError).toBe(false);
      await expect(client.callTool({ name: 'mutate_sandbox_data', arguments: {
        service: 'firestore', action: 'set', path: 'limit/healthy', dataJson: '{"value":"Healthy"}',
      } })).resolves.toMatchObject({ isError: false });
    } finally {
      const pid = transport.pid;
      const releasesHeldReads = holding && pid !== null;
      if (releasesHeldReads) process.kill(pid, 'SIGUSR2');
      await client.close().finally(() => transport.close()).finally(() => rmSync(project, { recursive: true, force: true }));
    }
  });
}
