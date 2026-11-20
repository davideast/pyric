// A server process downscopes firebase-admin's Realtime Database access with
// databaseAuthVariableOverride while a browser on the same hosted dev server
// signs in. The rules judge the server's writes as the override's auth, custom
// claims included; a null override is a signed-out client; no override is admin.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Attempt { allowed: boolean; value?: unknown; error?: string }
interface Repro { signIn(): Promise<string>; readNote(): Promise<Attempt>; writeNote(): Promise<Attempt> }
declare const repro: Repro;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'repro' in window);
    return page;
  });

  const uid = await app.step('sign in anonymously in the browser', () => page.evaluate(() => repro.signIn()));

  const server = await app.step('the server writes as the user, signed out, and as admin', () =>
    app.serverScript('server.mjs', [uid], { env: { PYRIC_SANDBOX: `remote:${host.url}` } }));

  await app.step('the rules judged each server write as its override', () => {
    assert.match(server.output, /own note as the user: allowed/);
    assert.match(server.output, /another user's note: denied \(.*PERMISSION_DENIED/i);
    assert.match(server.output, /public as the user: denied \(.*PERMISSION_DENIED/i);
    assert.match(server.output, /public signed out: allowed/);
    assert.match(server.output, /own note signed out: denied \(.*PERMISSION_DENIED/i);
    assert.match(server.output, /anywhere as admin: allowed/);
  });

  await app.step('the page reads the server write, and its own sign-in lacks the claim to write', async () => {
    const read = await page.evaluate(() => repro.readNote());
    assert.deepEqual(read, { allowed: true, value: { text: 'from the server' } }, JSON.stringify(read));
    const write = await page.evaluate(() => repro.writeNote());
    assert.equal(write.allowed, false, JSON.stringify(write));
    assert.match(write.error ?? '', /PERMISSION_DENIED/);
  });
});
