import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('a hosted service CLI write identifies its committed state when persistence fails', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/greeting',
      '--data', '{"message":"CLI committed in memory"}', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('The mutation committed in memory but could not be persisted. Do not repeat it;'),
    });
    await expect(page.locator('#document')).toHaveText('CLI committed in memory');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an unhealthy host refuses a service CLI mutation before changing the document', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/greeting',
      '--data', '{"message":"Must not execute"}', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('The mutation was not executed because hosted persistence is unhealthy.'),
    });
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an unhealthy host serves a service CLI read from its in-memory state', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'getDoc', '--path', 'shared/greeting', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).resolves.toMatchObject({
      stdout: expect.stringContaining('Hello from the other browser'),
    });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('a service CLI read identifies unhealthy in-memory state in its result', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'getDoc', '--path', 'shared/greeting', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).resolves.toMatchObject({
      stdout: expect.stringContaining('Hosted persistence is unhealthy; this read reflects in-memory state.'),
    });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('a refused CLI write retains its rules error when the state directory is unwritable', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await promisify(execFile)(process.execPath, [
      CLI_PATH, 'auth', 'actAsAnonymous', '--json',
    ], { cwd: serve.dir, timeout: 10_000 });
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/greeting',
      '--data', '{"message":"Must not execute"}', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('denied_by_rules'),
    });
    await expect(page.locator('#document')).toHaveText('Empty');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('service CLI identity switches still govern reads during a persistence failure', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'auth', 'actAsAnonymous', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).resolves.toMatchObject({
      stdout: expect.stringContaining('Acting as anonymous'),
    });
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'getDoc', '--path', 'shared/greeting', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('denied_by_rules'),
    });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('a partially applied CLI batch reports failed persistence without losing its operation error', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    const batch = promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'writeBatch', '--writes', JSON.stringify([
        { type: 'set', path: 'shared/greeting', data: { message: 'Partial CLI batch' } },
        { type: 'update', path: 'shared/missing', data: { message: 'Must fail' } },
      ]), '--json',
    ], { cwd: serve.dir, timeout: 10_000 });
    await expect(batch).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("Document 'shared/missing' does not exist"),
    });
    await expect(batch).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('Persistence also failed; some changes may exist only in memory. Inspect host state before retrying.'),
    });
    await expect(page.locator('#document')).toHaveText('Partial CLI batch');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('a partial CLI batch survives immediate host termination when persistence succeeds', async ({ browser }) => {
  const first = await startHostedFixture();
  const readerContext = await browser.newContext();
  try {
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'writeBatch', '--writes', JSON.stringify([
        { type: 'set', path: 'shared/greeting', data: { message: 'Persisted partial batch' } },
        { type: 'update', path: 'shared/missing', data: { message: 'Must fail' } },
      ]), '--json',
    ], { cwd: first.dir, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("Document 'shared/missing' does not exist"),
    });
    const terminated = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await terminated;

    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await readerContext.newPage();
      await reader.goto(first.info.url);
      await expect(reader.locator('#document')).toHaveText('Persisted partial batch');
    } finally {
      await replacement.stop();
    }
  } finally {
    await readerContext.close().finally(() => first.stop());
  }
});

test('a partial CLI batch with failed persistence prevents the next mutation', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'writeBatch', '--writes', JSON.stringify([
        { type: 'set', path: 'shared/greeting', data: { message: 'Partial CLI batch' } },
        { type: 'update', path: 'shared/missing', data: { message: 'Must fail' } },
      ]), '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).rejects.toMatchObject({ code: 2 });
    await expect(promisify(execFile)(process.execPath, [
      CLI_PATH, 'firestore', 'setDoc', '--path', 'shared/greeting',
      '--data', '{"message":"Must not execute"}', '--json',
    ], { cwd: serve.dir, timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('The mutation was not executed because hosted persistence is unhealthy.'),
    });
    await expect(page.locator('#document')).toHaveText('Partial CLI batch');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});
