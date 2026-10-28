// A Firestore ruleset whose root match names another database grants
// nothing (#1327, FS2-ENF-1). Production compares the root
// `/databases/other/documents` with the request's
// `/databases/(default)/documents/c/1`, so its `match /c/{id}` never
// applies and every read and write of c/1 is denied. The page on the dev
// server and a registered Node process both get permission-denied, and once
// `pyric rules set` installs the standard root both succeed.
import assert from 'node:assert/strict';
import { scenario, type App } from '../driver.ts';

declare const rootPath: { write(): Promise<string>; read(): Promise<string> };

const STANDARD_ROOT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow read, write: if true;
    }
  }
}`;

function outcome(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name} (.*)$`, 'm'));
  assert.ok(match, `no ${name} line in:\n${output}`);
  return match[1]!;
}

async function serverOutcomes(app: App, env: Record<string, string>) {
  const { output } = await app.serverScript('client.mjs', [], { env, timeoutMs: 30_000 });
  assert.match(output, /^client done$/m, output);
  return { write: outcome(output, 'write'), read: outcome(output, 'read') };
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  const page = await app.step('the page is denied c/1 under the root /databases/other/documents', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'rootPath' in window, undefined, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => rootPath.write()), 'permission-denied');
    assert.equal(await page.evaluate(() => rootPath.read()), 'permission-denied');
    return page;
  });

  await app.step('a registered Node process is denied c/1 under the same root', async () => {
    assert.deepEqual(await serverOutcomes(app, env), { write: 'permission-denied', read: 'permission-denied' });
  });

  await app.step('pyric rules set installs the standard root', async () => {
    const result = await app.pyric(['rules', 'set', '--service', 'firestore', '--rules', STANDARD_ROOT], { env });
    assert.equal(result.code, 0, result.output);
  });

  await app.step('the page reads and writes c/1 under the standard root', async () => {
    assert.equal(await page.evaluate(() => rootPath.write()), 'ok');
    assert.equal(await page.evaluate(() => rootPath.read()), 'ok');
  });

  await app.step('the Node process reads and writes c/1 under the standard root', async () => {
    assert.deepEqual(await serverOutcomes(app, env), { write: 'ok', read: 'ok' });
  });
});
