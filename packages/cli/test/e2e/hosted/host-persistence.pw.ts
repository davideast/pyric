import { DatabaseSync } from 'node:sqlite';
import { setPersistenceWritable } from './persistence-fault.js';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { CLI_PATH, McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('an acknowledged hosted SDK write survives immediate process termination', async ({ browser }) => {
  const first = await startHostedFixture();
  const writerContext = await browser.newContext();
  const readerContext = await browser.newContext();
  try {
    const writer = await writerContext.newPage();
    await writer.goto(first.info.url);
    await writer.getByRole('button', { name: 'Write shared document' }).click();
    await expect(writer.locator('#write-result')).toHaveText('Written');
    const terminated = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await terminated;
    await writerContext.close();

    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await readerContext.newPage();
      await reader.goto(first.info.url);
      await expect(reader.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await replacement.stop();
    }
  } finally {
    await writerContext.close();
    await readerContext.close().finally(() => first.stop());
  }
});

test('an acknowledged hosted MCP write survives immediate process termination', async ({ browser }) => {
  const first = await startHostedFixture();
  const readerContext = await browser.newContext();
  try {
    const mcp = new McpHttpClient(`${first.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'Acknowledged by MCP' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    const terminated = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await terminated;

    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await readerContext.newPage();
      await reader.goto(first.info.url);
      await expect(reader.locator('#document')).toHaveText('Acknowledged by MCP');
    } finally {
      await replacement.stop();
    }
  } finally {
    await readerContext.close().finally(() => first.stop());
  }
});

test('an acknowledged hosted service CLI write survives immediate process termination', async ({ browser }) => {
  const first = await startHostedFixture();
  const readerContext = await browser.newContext();
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/greeting',
      '--data', '{"message":"Acknowledged by the service CLI"}', '--json',
    ], { cwd: first.dir, timeout: 10_000 });
    const result: unknown = JSON.parse(stdout);
    expect(result).toMatchObject({ ok: true });
    const terminated = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await terminated;

    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await readerContext.newPage();
      await reader.goto(first.info.url);
      await expect(reader.locator('#document')).toHaveText('Acknowledged by the service CLI');
    } finally {
      await replacement.stop();
    }
  } finally {
    await readerContext.close().finally(() => first.stop());
  }
});

test('a host refuses corrupt state before advertising readiness and preserves the file', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-corrupt-host-state-'));
  const stateDir = join(project, '.pyric/state/hosted');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'state.sqlite');
  const damagedState = '{broken JSON';
  writeFileSync(statePath, damagedState);
  const host = startHost(project);
  try {
    expect(await host.startup, host.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(host.stderr()).toContain('Hosted state could not be restored');
    expect(readFileSync(statePath, 'utf8')).toBe(damagedState);
  } finally {
    await host.stop();
    rmSync(project, { recursive: true, force: true });
  }
});

test('a host refuses unsupported persisted record versions before readiness', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-versioned-host-state-'));
  const stateDir = join(project, '.pyric/state/hosted');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'state.sqlite');
  const database = new DatabaseSync(statePath);
  database.exec('PRAGMA user_version=999');
  database.close();
  const unsupportedState = readFileSync(statePath);
  const host = startHost(project);
  try {
    expect(await host.startup, host.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(host.stderr()).toContain('Hosted state could not be restored');
    expect(readFileSync(statePath)).toEqual(unsupportedState);
  } finally {
    await host.stop();
    rmSync(project, { recursive: true, force: true });
  }
});

test('a hosted SDK write reports committed but not durable when the SQLite commit fails', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    setPersistenceWritable(stateDirectory, false);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText(
      'Write failed: The mutation committed in memory but could not be persisted. Do not repeat it; restore persistence before further mutations.',
    );
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    setPersistenceWritable(stateDirectory, true);
    await serve.stop();
  }
});

test('an unhealthy host refuses further SDK mutations while allowing reads', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    setPersistenceWritable(stateDirectory, false);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    const result = await page.evaluate(async () => {
      const { doc, getDoc, getFirestore, setDoc } = await import('firebase/firestore');
      const reference = doc(getFirestore(), 'shared', 'second');
      let outcome = 'acknowledged';
      try {
        await setDoc(reference, { message: 'Must not execute' });
      } catch (error) {
        const hasCode = error instanceof Error && 'code' in error;
        if (hasCode) outcome = String(error.code);
        else throw error;
      }
      return { outcome, exists: (await getDoc(reference)).exists() };
    });
    expect(result).toEqual({ outcome: 'persistence-unhealthy', exists: false });
  } finally {
    setPersistenceWritable(stateDirectory, true);
    await serve.stop();
  }
});

test('a hosted MCP write identifies its committed state when persistence fails', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    mkdirSync(stateDirectory, { recursive: true });
    setPersistenceWritable(stateDirectory, false);
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'MCP committed in memory' }, as: 'admin',
    })).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('The mutation committed in memory but could not be persisted. Do not repeat it;'),
    });
    await expect(page.locator('#document')).toHaveText('MCP committed in memory');
  } finally {
    setPersistenceWritable(stateDirectory, true);
    await serve.stop();
  }
});
