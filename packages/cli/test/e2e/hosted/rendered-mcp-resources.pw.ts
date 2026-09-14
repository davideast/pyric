import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';

for (const completion of ['success', 'failure']) {
  test(`rendered resources share tool admission and recover after ${completion}`, async () => {
    const project = mkdtempSync(join(tmpdir(), 'pyric-resource-capacity-'));
    const preload = join(project, 'hold-storage-read.mjs');
    const failsFirstReads = completion === 'failure';
    writeHeldStorageReadPreload(preload, failsFirstReads);
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', preload, CLI_PATH, 'mcp', '--in-process', '--surface', 'discriminator'],
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
      await expect(client.callTool({ name: 'manage_storage_files', arguments: {
        action: 'upload', path: 'held/note.txt', base64Content: 'eA==', contentType: 'application/x-pyric-held',
      } })).resolves.toMatchObject({ isError: false });
      for (const round of [0, 1]) {
        const rearmsReads = round === 1;
        if (rearmsReads) {
          process.kill(pid, 'SIGUSR2');
          holding = true;
          await expect.poll(() => stderr).toContain('ARMED\n');
        }
        const accepted = Array.from({ length: 256 }, () => client.callTool({ name: 'manage_storage_files', arguments: {
          action: 'download', path: 'held/note.txt',
        } }).catch((error: unknown) => ({ isError: true, error: String(error) })));
        await expect.poll(() => stderr.split('\n').filter(line => line === 'HELD').length).toBe((round + 1) * 256);
        await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
          contents: [{ text: expect.stringContaining('256 pending operations') }],
        });
        // Protocol discovery remains usable while operation admission is full.
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        process.kill(pid, 'SIGUSR2');
        holding = false;
        const expectsFailure = failsFirstReads && round === 0;
        for (const result of await Promise.all(accepted)) expect(result.isError).toBe(expectsFailure);
        await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
          contents: [{ text: expect.stringContaining('"ok": true') }],
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

test('rendered resource reads release capacity after success, failure and SDK URI refusal', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-resource-release-'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI_PATH, 'mcp', '--in-process', '--surface', 'discriminator'],
    cwd: project, stderr: 'pipe',
  });
  const client = new Client({ name: 'resource-release', version: '1' });
  try {
    await client.connect(transport);
    // More reads than the pending limit catches reservations leaked on either outcome.
    const rounds = Array.from({ length: 257 }, (_, index) => index);
    for (const round of rounds) {
      await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('"ok": true') }],
      });
      await expect(client.readResource({ uri: 'pyric://stdlib/rules/no-such-module' }), `Read cycle ${round}`).resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('"ok": false') }],
      });
    }
    // The MCP SDK refuses overlong URIs before calling the resource handler.
    const uri = `pyric://firestore/docs/held/${'a'.repeat(1_000_000)}`;
    await expect(client.readResource({ uri })).rejects.toThrow('URI exceeds maximum length of 1000000 characters');
    await expect(client.readResource({ uri: 'pyric://sandbox/status' })).resolves.toMatchObject({
      contents: [{ text: expect.stringContaining('"ok": true') }],
    });
  } finally {
    await client.close().finally(() => transport.close()).finally(() => rmSync(project, { recursive: true, force: true }));
  }
});
