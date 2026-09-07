/**
 * `avatars: false` restores Firebase-null `photoURL` fidelity and unmounts
 * the asset route entirely (docs/auth-avatars-design.md). `pyric sandbox`
 * has no CLI flag for this — it resolves `avatars` from `PYRIC_AVATARS` only
 * (see serve.ts) — so this spec is self-booting (ai-demo.pw.ts's pattern):
 * it spawns its OWN `pyric sandbox --port 0` with `PYRIC_AVATARS=false` on
 * the SAME fixture this directory's shared webServer serves, rather than
 * relying on the config's default-avatars instance. Requires the built dist
 * (`bun run build:cli`), same as the rest of this directory.
 */
import { test, expect, chromium, type Browser } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', '..', 'dist', 'cli', 'index.js');
const FIXTURE_DIR = join(HERE, 'fixture');

let child: ChildProcess | null = null;
let serveUrl = '';
let browser: Browser;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  browser = await chromium.launch({ headless: true });
  const proc = spawn(
    process.execPath,
    // --no-cache: test the worker/entry bundles as built, never a warm cache.
    [CLI_PATH, 'sandbox', '--no-open', '--port', '0', '--json', '--no-cache'],
    {
      cwd: FIXTURE_DIR,
      env: { ...process.env, PYRIC_AVATARS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = proc;
  let out = '';
  let err = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stdout!.on('data', (c: string) => (out += c));
  proc.stderr!.on('data', (c: string) => (err += c));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`pyric sandbox exited early (code ${proc.exitCode}). stderr:\n${err.slice(-2000)}`);
    }
    const line = out.split('\n').find((l) => l.trim().startsWith('{'));
    if (line) {
      serveUrl = (JSON.parse(line) as { url: string }).url;
      break;
    }
    if (Date.now() >= deadline) throw new Error(`pyric sandbox --json line never arrived. stderr:\n${err.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child!.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(killTimer);
  }
});

test('avatars: false restores photoURL: null on provider sign-in and 404s the asset route', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${serveUrl}/`);
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 15_000 });

  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const generation = localStorage.getItem('pyric:worker-generation');
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker',
    });
    const id = `enable-google-${Date.now()}`;
    worker.port.onmessage = (event) => {
      if (event.data?.t !== 'res' || event.data.id !== id) return;
      worker.port.close();
      if (event.data.ok) resolve();
      else reject(Object.assign(new Error(event.data.error.message), event.data.error));
    };
    worker.port.start();
    worker.port.postMessage({
      t: 'op',
      id,
      method: 'auth.setProviderConfig',
      providerId: 'google.com',
      enabled: true,
    });
  }));

  await page.locator('#signin').click();
  const dialog = page.locator('dialog[data-pyric-auth]');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="email"]').fill('gina@example.com');
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('Gina');
  await dialog.locator('button.submit').click();

  await expect(page.locator('#status')).toHaveText(/^signed-in:/, { timeout: 10_000 });

  // Even a real provider sign-in gets Firebase's own no-photo behaviour when
  // this host disables avatars.
  const photoURL = await page.evaluate(() => (window as unknown as { __photoURL: string | null }).__photoURL);
  expect(photoURL).toBeNull();

  // The route is unmounted (namespace.ts), not merely empty — any request
  // shaped like an avatar fetch 404s.
  const response = await page.request.get(`${serveUrl}/__pyric/assets/avatar/whoever?d=x`);
  expect(response.status()).toBe(404);

  await context.close();
});
