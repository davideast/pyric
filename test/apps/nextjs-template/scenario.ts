// The Next.js template from `create-pyric --template nextjs`, run as its
// README says: `pyric sandbox -- next dev`, with and without `--hosted`, under
// webpack and Turbopack. The page's client component must mount, read the
// signed-out auth state, see a post firebase-admin writes, and have a signed-out
// write denied by the template's rules, with no page error. Before #1193 was
// fixed every load threw "Missing Pyric page initialization" and nothing mounted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scenario, sleep, type App } from '../driver.ts';

interface Case {
  name: string;
  hosted: boolean;
  turbopack: boolean;
}

const CASES: readonly Case[] = [
  { name: 'pyric sandbox -- next dev', hosted: false, turbopack: false },
  { name: 'pyric sandbox --hosted -- next dev', hosted: true, turbopack: false },
  { name: 'pyric sandbox -- next dev --turbopack', hosted: false, turbopack: true },
];

/** Scaffolds the template with the installed create-pyric and lays its files over the installed app. */
function scaffold(app: App): void {
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

async function runCase(app: App, testCase: Case): Promise<void> {
  const sandboxPort = await app.freePort();
  const nextPort = await app.freePort();
  const nextUrl = `http://127.0.0.1:${nextPort}`;
  const sandboxUrl = `http://localhost:${sandboxPort}`;
  const nextArgs = ['next', 'dev', '--port', String(nextPort), '--hostname', '127.0.0.1'];
  if (testCase.turbopack) nextArgs.push('--turbopack');
  const sandboxArgs = ['sandbox', '--no-open', '--port', String(sandboxPort)];
  if (testCase.hosted) sandboxArgs.push('--hosted');
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

  await app.step(`${testCase.name}: the page raised no error`, async () => {
    const pageErrors = app.browserLog.slice(logStart).filter((line) => / error\] /.test(line));
    assert.deepEqual(pageErrors, []);
    await page.close();
    await sandbox.stop();
  });
}

export default scenario(async (app) => {
  // The rewrite keeps the Next origin, which the host's origin guard refuses (#1194).
  app.expectHostError(/^403 POST \/__pyric\/diagnostics$/);
  await app.step('create-pyric scaffolds the nextjs template', () => scaffold(app));
  for (const testCase of CASES) await runCase(app, testCase);
});
