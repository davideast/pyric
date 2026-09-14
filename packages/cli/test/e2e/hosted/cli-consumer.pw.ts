import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { CLI_PATH, McpHttpClient, startSoakServe } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';

async function cli(projectDir: string, ...args: string[]): Promise<unknown> {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI_PATH, ...args, '--json'], {
    cwd: projectDir,
    timeout: 10_000,
  });
  return JSON.parse(stdout);
}

test('the service CLI reads the document written by a hosted browser', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(cli(serve.dir, 'firestore', 'getDoc', '--path', 'shared/greeting')).resolves.toMatchObject({
      ok: true,
      data: { exists: true, data: { message: 'Hello from the other browser' } },
    });
  } finally {
    await context.close().finally(() => serve.stop());
  }
});

test('a copied discovery pointer cannot send CLI writes to another project', async () => {
  const serve = await startHostedFixture();
  const foreignProject = mkdtempSync(join(tmpdir(), 'pyric-foreign-cli-'));
  try {
    mkdirSync(join(foreignProject, '.pyric'));
    copyFileSync(join(serve.dir, '.pyric/serve.json'), join(foreignProject, '.pyric/serve.json'));
    await expect(cli(foreignProject, 'firestore', 'setDoc', '--path', 'shared/foreign', '--data', '{"message":"Wrong project"}'))
      .rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('another project') });
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/foreign', as: 'admin' }))
      .resolves.toMatchObject({ ok: true, data: { exists: false } });
  } finally {
    rmSync(foreignProject, { recursive: true, force: true });
    await serve.stop();
  }
});

test('the service CLI seeds the host before browsers connect', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    await expect(cli(serve.dir, 'firestore', 'setDoc', '--path', 'shared/greeting', '--data', '{"message":"Seeded through CLI"}'))
      .resolves.toMatchObject({ ok: true });
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Seeded through CLI');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
      .resolves.toMatchObject({ ok: true, data: { exists: true, data: { message: 'Seeded through CLI' } } });
  } finally {
    await context.close().finally(() => serve.stop());
  }
});

test('hosted CLI calls retain their selected lens and report a rules refusal', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    await expect(cli(serve.dir, 'auth', 'actAsAnonymous')).resolves.toMatchObject({ ok: true });
    await expect(cli(serve.dir, 'firestore', 'setDoc', '--path', 'shared/greeting', '--data', '{"message":"Refused"}'))
      .rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('denied_by_rules') });
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect(cli(serve.dir, 'auth', 'actAsAdmin')).resolves.toMatchObject({ ok: true });
    await expect(cli(serve.dir, 'firestore', 'setDoc', '--path', 'shared/greeting', '--data', '{"message":"Allowed"}'))
      .resolves.toMatchObject({ ok: true });
    await expect(page.locator('#document')).toHaveText('Allowed');
  } finally {
    await context.close().finally(() => serve.stop());
  }
});

test('a service command in a project subdirectory attaches to its host', async () => {
  const serve = await startHostedFixture();
  try {
    const nestedDir = join(serve.dir, 'src');
    mkdirSync(nestedDir);
    await expect(cli(nestedDir, 'firestore', 'setDoc', '--path', 'shared/nested', '--data', '{"source":"subdirectory"}'))
      .resolves.toMatchObject({ ok: true });
    await expect(cli(serve.dir, 'firestore', 'getDoc', '--path', 'shared/nested'))
      .resolves.toMatchObject({ ok: true, data: { exists: true, data: { source: 'subdirectory' } } });
  } finally {
    await serve.stop();
  }
});

test('the default SharedWorker host keeps the service CLI refusal', async () => {
  const serve = await startSoakServe({ flags: ['--no-capture'] });
  try {
    await expect(cli(serve.dir, 'firestore', 'getDoc', '--path', 'shared/greeting'))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('reach the running sandbox through `pyric mcp`') });
  } finally {
    await serve.stop();
  }
});
