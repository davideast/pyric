// The Next.js template from `create-pyric --template nextjs`, run as its
// README says: `pyric sandbox -- next dev`, with and without `--hosted`, under
// Turbopack (the Next 16 default) and webpack. The page's client component must
// mount, read the signed-out auth state, see a post firebase-admin writes, and
// have a signed-out write denied by the template's rules, with no page error.
// Before #1193 was fixed every load threw "Missing Pyric page initialization"
// and nothing mounted.
// The rewrite keeps the page's Next origin, and the host accepts it on the
// guarded `/__pyric/*` routes (#1194): diagnostics answer without a 403, and
// the `--persist` case saves `state.json`. A page on another local port still
// gets 403, both through the rewrite and straight to the host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { scenario, sleep, type App } from '../driver.ts';

interface Case {
  name: string;
  hosted: boolean;
  webpack: boolean;
  persist: boolean;
}

const CASES: readonly Case[] = [
  { name: 'pyric sandbox -- next dev', hosted: false, webpack: false, persist: false },
  { name: 'pyric sandbox --hosted -- next dev', hosted: true, webpack: false, persist: false },
  { name: 'pyric sandbox -- next dev --webpack', hosted: false, webpack: true, persist: false },
  { name: 'pyric sandbox --persist -- next dev', hosted: false, webpack: false, persist: true },
];

/** Marks the other page's requests, so the host's 403s to them are the only ones expected. */
const OTHER_PORT_PROBE = 'from=other-port';
/** The console line Chromium prints for any failed response; the response lines say which. */
const FAILED_RESOURCE = /^\[page \d+ console\.error\] Failed to load resource: /;

/** Scaffolds the template with the installed create-pyric, lays its files over the installed app, and returns the scaffold's directory. */
function scaffold(app: App): string {
  const bin = join(app.dir, 'node_modules', 'create-pyric', 'dist', 'bin.js');
  // Beside the app, in the run's directory, so Next and tsconfig never see a second src/app.
  const scaffolded = join(dirname(app.dir), 'scaffolded');
  execFileSync('node', [bin, scaffolded, '--template', 'nextjs', '--name', 'nextjs-template'], { cwd: app.dir, stdio: 'pipe' });
  // The app's package.json pins versions of what the template names; it must name every package.
  const template = JSON.parse(readFileSync(join(scaffolded, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const installed = JSON.parse(app.readFile('package.json')) as Record<string, Record<string, string>>;
  const names = (manifest: Record<string, Record<string, string>>) =>
    [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  const missing = names(template).filter((name) => !names(installed).includes(name));
  assert.deepEqual(missing, [], 'the scenario installs every package the template depends on');
  for (const entry of readdirSync(scaffolded)) {
    if (entry === 'package.json') continue;
    cpSync(join(scaffolded, entry), join(app.dir, entry), { recursive: true });
  }
  return scaffolded;
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForNext(url: string, running: () => boolean): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    assert.ok(running(), `pyric sandbox exited before Next served ${url}`);
    // The rewrite reaches the sandbox, and the first `/` compiles the page.
    if (await answers(`${url}/__pyric/init.json`) && await answers(`${url}/`)) return;
    assert.ok(Date.now() < deadline, `Next did not serve ${url}/ and ${url}/__pyric/init.json within 180s`);
    await sleep(500);
  }
}

async function startOtherPortServer(port: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>other</title><p>Another local app.</p>');
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

/** Runs in the page: a CORS request naming the page's own port as the proxy's. */
async function tryNamingOwnPort(input: { url: string; forwardedHost: string }): Promise<string> {
  try {
    const response = await fetch(input.url, { headers: { 'x-forwarded-host': input.forwardedHost } });
    return `answered ${response.status}`;
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

/** Runs in the page: a POST a page can send without a preflight. */
async function tryPost(url: string): Promise<string> {
  try {
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{}' });
    return 'sent';
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

/** The status the host answered a no-cors POST with, which only the network sees. */
async function postStatus(page: Page, url: string): Promise<number> {
  const answered = page.waitForResponse((response) => response.url() === url, { timeout: 30_000 });
  assert.equal(await page.evaluate(tryPost, url), 'sent');
  return (await answered).status();
}

/** A page on another port of the Next page's own host must not reach the guarded routes. */
async function refusesOtherPort(app: App, testCase: Case, urls: { next: string; sandbox: string }): Promise<void> {
  const otherPort = await app.freePort();
  const other = await startOtherPortServer(otherPort);
  try {
    await app.step(`${testCase.name}: a page on another port gets 403 on a guarded route`, async () => {
      const page = await app.page(`http://127.0.0.1:${otherPort}/`);
      // First try to teach the host this port, naming it the way a proxy would.
      const forwardedHost = `127.0.0.1:${otherPort}`;
      await page.evaluate(tryNamingOwnPort, { url: `${urls.sandbox}/__pyric/not-a-route`, forwardedHost });
      await page.evaluate(tryNamingOwnPort, { url: `${urls.next}/__pyric/not-a-route`, forwardedHost });
      const throughRewrite = await postStatus(page, `${urls.next}/__pyric/diagnostics?${OTHER_PORT_PROBE}`);
      const straightToHost = await postStatus(page, `${urls.sandbox}/__pyric/diagnostics?${OTHER_PORT_PROBE}`);
      assert.deepEqual({ throughRewrite, straightToHost }, { throughRewrite: 403, straightToHost: 403 });
      await page.close();
    });
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
}

async function runCase(app: App, testCase: Case): Promise<void> {
  const sandboxPort = await app.freePort();
  const nextPort = await app.freePort();
  const nextUrl = `http://127.0.0.1:${nextPort}`;
  const sandboxUrl = `http://localhost:${sandboxPort}`;
  const nextArgs = ['next', 'dev', '--port', String(nextPort), '--hostname', '127.0.0.1'];
  if (testCase.webpack) nextArgs.push('--webpack');
  const sandboxArgs = ['sandbox', '--no-open', '--port', String(sandboxPort)];
  if (testCase.hosted) sandboxArgs.push('--hosted');
  if (testCase.persist) sandboxArgs.push('--persist');
  const env = { PATH: `${join(app.dir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` };

  const sandbox = await app.step(`${testCase.name}: Next serves the template`, async () => {
    const child = app.pyricProcess([...sandboxArgs, '--', ...nextArgs], { env });
    await waitForNext(nextUrl, () => child.running);
    return child;
  });

  const logStart = app.browserLog.length;
  const page = await app.step(`${testCase.name}: the client component mounts and reads the auth state`, async () => {
    const opened = await app.page(`${nextUrl}/`);
    await opened.waitForFunction(
      () => document.querySelector('#auth-status')?.textContent === 'Signed out',
      undefined,
      { timeout: 60_000 },
    );
    return opened;
  });

  await app.step(`${testCase.name}: the page lists a post firebase-admin writes`, async () => {
    const title = `seeded under ${testCase.name}`;
    const { output } = await app.serverScript('seed.mjs', [title], {
      env: { PYRIC_SANDBOX: `remote:${sandboxUrl}` },
      timeoutMs: 60_000,
    });
    assert.match(output, /^seeded$/m, output);
    await page.waitForFunction(
      (expected) => document.querySelector('#posts-list')?.textContent?.includes(expected) === true,
      title,
      { timeout: 30_000 },
    );
  });

  await app.step(`${testCase.name}: the server route reads the sandbox`, async () => {
    await page.waitForFunction(
      () => /^Server-Side Admin API Runtime: pyric-sandbox \(\d+ database records\)$/.test(
        document.querySelector('#api-status')?.textContent ?? '',
      ),
      undefined,
      { timeout: 30_000 },
    );
  });

  await app.step(`${testCase.name}: the template's rules deny a signed-out write`, async () => {
    await page.fill('#post-title-input', 'signed-out post');
    await page.click('#submit-post-button');
    await page.waitForFunction(
      () => document.querySelector('#auth-status')?.textContent?.startsWith('Denied by security rules') === true,
      undefined,
      { timeout: 30_000 },
    );
  });

  if (testCase.persist) {
    // The SharedWorker saves state through the rewrite with the Next origin.
    // The driver does not see SharedWorker requests, so the file is the evidence.
    await app.step(`${testCase.name}: the sandbox saves its state, with the seeded post`, async () => {
      const stateFile = join(app.dir, '.pyric', 'state', 'state.json');
      const title = `seeded under ${testCase.name}`;
      // Persistence debounces a save by 400 ms; 30 s is ample for one to land.
      const deadline = Date.now() + 30_000;
      const saved = () => existsSync(stateFile) && readFileSync(stateFile, 'utf8').includes(title);
      while (!saved()) {
        assert.ok(Date.now() < deadline, `${stateFile} did not save the post "${title}" within 30s`);
        await sleep(250);
      }
    });
  }

  await app.step(`${testCase.name}: the page raised no error`, async () => {
    const lines = app.browserLog.slice(logStart);
    const pageErrors = lines.filter((line) => / error\] /.test(line));
    const consoleErrors = lines.filter((line) => / console\.error\] /.test(line) && !FAILED_RESOURCE.test(line));
    const errorResponses = lines.filter((line) => / response \d+\] /.test(line));
    assert.deepEqual({ pageErrors, consoleErrors, errorResponses }, { pageErrors: [], consoleErrors: [], errorResponses: [] });
    await page.close();
  });

  await refusesOtherPort(app, testCase, { next: nextUrl, sandbox: sandboxUrl });

  await app.step(`${testCase.name}: pyric sandbox stops`, () => sandbox.stop());
}

export default scenario(async (app) => {
  // Only the other page is refused: its probes, and the requests that name its port.
  app.expectHostError(new RegExp(`^403 POST /__pyric/diagnostics\\?${OTHER_PORT_PROBE}$`));
  app.expectHostError(/^\d+ GET \/__pyric\/not-a-route$/);
  const scaffolded = await app.step('create-pyric scaffolds the nextjs template', () => scaffold(app));
  for (const testCase of CASES) await runCase(app, testCase);
  // Next rewrites a tsconfig.json it disagrees with on the first `next dev`,
  // which would leave a fresh project with a change to commit.
  await app.step('next dev leaves the template\'s tsconfig.json as scaffolded', () => {
    assert.equal(app.readFile('tsconfig.json'), readFileSync(join(scaffolded, 'tsconfig.json'), 'utf8'));
  });
});
