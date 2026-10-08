// A server process writes to a named RTDB instance through firebase-admin's
// getDatabaseWithUrl while a browser on the same hosted dev server reads it.
// Each database URL is its own instance with its own data and rules.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface RoomRead { allowed: boolean; exists?: boolean; error?: string }
interface Repro { signIn(): Promise<string>; readRoom(): Promise<{ shard: RoomRead; default: RoomRead }> }
declare const repro: Repro;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'repro' in window);
    return page;
  });

  const uid = await app.step('sign in anonymously in the browser', () => page.evaluate(() => repro.signIn()));

  const server = await app.step('the server writes rooms/r1 through the shard URL', () =>
    app.serverScript('server.mjs', [uid], { env: { PYRIC_SANDBOX: `remote:${host.url}` } }));

  await app.step('admin reads find the room only through the shard URL', () => {
    assert.match(server.output, /admin read via shard URL: exists=true/);
    assert.match(server.output, /admin read via default URL: exists=false/);
  });

  await app.step('the browser reads the room on the shard and is denied on the default instance', async () => {
    const read = await page.evaluate(() => repro.readRoom());
    assert.deepEqual(read.shard, { allowed: true, exists: true });
    assert.equal(read.default.allowed, false, `default instance read: ${JSON.stringify(read.default)}`);
    assert.match(read.default.error ?? '', /PERMISSION_DENIED/);
  });
});
