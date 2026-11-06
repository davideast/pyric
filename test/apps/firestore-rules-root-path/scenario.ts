// A Firestore ruleset whose root match names another database grants
// nothing (#1327, FS2-ENF-1). Production compares the root
// `/databases/other/documents` with the request's
// `/databases/(default)/documents/c/1`, so its `match /c/{id}` never
// applies and every read and write of c/1 is denied. The page on the dev
// server and a registered Node process both get permission-denied, and once
// `pyric rules set` installs the standard root both succeed.
//
// A root `match /{path=**}` matches the request's full resource name, so the
// allow statements written on it apply as on any other block (#1894,
// FS3-ROOT-1). Production allows get `c/1` under its `allow read: if true`
// and denies a signed-out create under its `allow write: if request.auth !=
// null` (captures `c4a-root-recursive-with-own-allow`,
// `c5e-root-recursive-own-allow-write`). Both clients are signed out, so
// they read c/1 and are denied the write.
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

const RECURSIVE_ROOT_OWN_RULES = `rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow read: if true;
    allow write: if request.auth != null;
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

  await app.step('pyric rules set installs a root /{path=**} with rules of its own', async () => {
    const result = await app.pyric(['rules', 'set', '--service', 'firestore', '--rules', RECURSIVE_ROOT_OWN_RULES], { env });
    assert.equal(result.code, 0, result.output);
  });

  await app.step("the page reads c/1 under the root's allow read and is denied the signed-out write", async () => {
    assert.equal(await page.evaluate(() => rootPath.read()), 'ok');
    assert.equal(await page.evaluate(() => rootPath.write()), 'permission-denied');
  });

  await app.step("the Node process reads c/1 under the root's allow read and is denied the signed-out write", async () => {
    assert.deepEqual(await serverOutcomes(app, env), { write: 'permission-denied', read: 'ok' });
  });
});
