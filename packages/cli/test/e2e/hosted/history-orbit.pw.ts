import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';

const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const execute = promisify(execFile);

test('Orbit shares writes across profiles and exposes durable history through the CLI', async ({ browser }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-history-orbit-')));
  const ignored = new Set(['node_modules', '.pyric', 'dist', 'test-results']);
  const sender = await browser.newContext();
  const recipient = await browser.newContext();
  sender.setDefaultTimeout(10_000);
  recipient.setDefaultTimeout(10_000);
  let server: ViteDevServer | undefined;
  try {
    cpSync(join(repository, 'examples/teams-workspace'), root, { recursive: true, filter: path => !ignored.has(basename(path)) && !basename(path).startsWith('.env') });
    symlinkSync(join(repository, 'examples/teams-workspace/node_modules'), join(root, 'node_modules'), 'dir');
    server = await createServer({ root, configFile: false, cacheDir: join(root, '.vite-cache'), logLevel: 'silent',
      plugins: [pyric({ hosted: true, seed: 'seed.json', bridge: true, runtimeChip: true, capture: false })],
      server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    const missingOrigin = origin === undefined;
    if (missingOrigin) throw new Error('Orbit test server did not publish an origin.');
    const david = await sender.newPage();
    const alice = await recipient.newPage();
    for (const [page, name] of [[david, 'david'], [alice, 'alice']] as const) {
      await page.goto(origin);
      await page.getByLabel('Email', { exact: true }).fill(`${name}@orbit.example`);
      await page.getByLabel('Password', { exact: true }).fill('orbit-demo');
      await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    }
    const message = 'Durable history checkpoint';
    await david.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
    await david.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.locator('.conversation-body').getByText(message, { exact: true })).toBeVisible();
    const cli = join(repository, 'packages/cli/dist/cli/index.js');
    const port = new URL(origin).port;
    const run = async (...args: string[]) => execute(process.execPath, [cli, 'sandbox', 'history', ...args], { cwd: root, timeout: 15_000 });
    const status = JSON.parse((await run('status', '--port', port)).stdout);
    expect(status.healthy).toBe(true);
    expect(status.undo.undoCount).toBeGreaterThan(0);
    const archive = join(root, 'history-backup');
    await run('export', '--port', port, '--out', archive);
    const verified = JSON.parse((await run('verify', '--out', archive)).stdout);
    expect(verified.records).toBeGreaterThan(0);
    const history = JSON.parse((await run('list', '--port', port, '--service', 'firestore', '--limit', '1000')).stdout);
    expect(JSON.stringify(history)).toContain(message);
    await alice.reload();
    await expect(alice.locator('.conversation-body').getByText(message, { exact: true })).toBeVisible();
  } finally {
    await Promise.allSettled([sender.close(), recipient.close()]);
    try { await server?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});
