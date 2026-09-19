import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import type { WriteSandboxEvent } from 'pyric/sandbox';

test('a persisted branch reports literal field names and preserves unrelated live changes on promotion', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-branch-values-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [CLI_PATH, 'mcp', '--in-process'], cwd: project, stderr: 'pipe' });
  const client = new Client({ name: 'branch-values-fixture', version: '1.0.0' });
  const call = (name: string, method: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { method, args } });
  const literal = { __type: 'timestamp', seconds: 5, nanos: 0, note: 'saved' };
  try {
    await client.connect(transport);
    const written = await call('firestore', 'setDoc', { path: 'shared/values', data: { literal } });
    expect(written.isError).not.toBe(true);
    const forked = await call('sandbox', 'fork', { branch: 'values' });
    expect(forked.isError).not.toBe(true);
    const changed = await call('firestore', 'setDoc', {
      path: 'shared/values', data: { literal: { ...literal, note: 'changed' } },
    });
    expect(changed.isError).not.toBe(true);
    const report = await call('sandbox', 'diff', { branch: 'values' });
    expect(report.isError).not.toBe(true);
    expect(report.content).toEqual([{ type: 'text', text: expect.stringMatching(/"field":\s*"literal\.note"/) }]);
    const promoted = await call('sandbox', 'promote', { branch: 'values', confirm: true });
    expect(promoted.isError).not.toBe(true);
    const restored = await call('firestore', 'getDoc', { path: 'shared/values' });
    expect(restored.isError).not.toBe(true);
    expect(restored.content).toEqual([{ type: 'text', text: expect.stringMatching(/"note":\s*"changed"/) }]);
  } finally {
    await client.close();
    await transport.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('promotion of a persisted branch preserves changed timestamp and literal map values', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-branch-promotion-values-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [CLI_PATH, 'mcp', '--in-process'], cwd: project, stderr: 'pipe' });
  const client = new Client({ name: 'branch-promotion-fixture', version: '1.0.0' });
  const call = (name: string, method: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { method, args } });
  const literal = { __type: 'timestamp', seconds: 5, nanos: 0, note: 'branch' };
  const write: WriteSandboxEvent = {
    kind: 'write', id: 'saved-write', at: 1700000000123, method: 'set', path: 'shared/values', auth: null,
    data: { timestamp: { __type: 'serverTimestamp' }, literal }, priorState: null,
    nextState: { timestamp: { __type: 'timestamp', seconds: 1700000000, nanos: 123000000 }, literal },
    requestTime: { seconds: 1700000000, nanoseconds: 123000000 },
  };
  try {
    await client.connect(transport);
    const forked = await call('sandbox', 'fork', { branch: 'values', candidateRules:
      'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read, write: if true; } } }' });
    expect(forked.isError).not.toBe(true);
    const applied = await call('sandbox', 'apply', { branch: 'values', events: [write] });
    expect(applied.isError).not.toBe(true);
    const promoted = await call('sandbox', 'promote', { branch: 'values', confirm: true });
    expect(promoted.isError).not.toBe(true);
    const restored = await call('firestore', 'getDoc', { path: 'shared/values' });
    expect(restored.isError).not.toBe(true);
    expect(restored.content).toEqual([{ type: 'text', text: expect.stringMatching(/"note":\s*"branch"/) }]);
    const installed = await call('rules', 'set', { service: 'firestore',
      rules: 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read: if resource.data.timestamp is timestamp && resource.data.timestamp.toMillis() == 1700000000123 && resource.data.literal is map && resource.data.literal.note == "branch"; } } }' });
    expect(installed.isError).not.toBe(true);
    const anonymous = await call('auth', 'actAsAnonymous', {});
    expect(anonymous.isError).not.toBe(true);
    const evaluated = await call('firestore', 'getDoc', { path: 'shared/values' });
    expect(evaluated.isError).not.toBe(true);
    expect(evaluated.content).toEqual([{ type: 'text', text: expect.stringMatching(/"exists":\s*true/) }]);
  } finally {
    await client.close();
    await transport.close();
    rmSync(project, { recursive: true, force: true });
  }
});
