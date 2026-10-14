// A page writes to a named RTDB instance and to the default instance on the
// Node host. `pyric database <method> --instance <name>` then runs as a
// process against that host: it reads and writes only the instance it names,
// accepts a name, a URL, or `default`, and refuses an instance the project
// does not have (#967).
import assert from 'node:assert/strict';
import { scenario, type App } from '../driver.ts';

interface Lobbies { default: unknown; shard: unknown }
interface Repro {
  signIn(): Promise<string>;
  writeLobbies(): Promise<void>;
  read(path: string): Promise<Lobbies>;
}
declare const repro: Repro;

/** Run the installed `pyric` command from the app directory and return what it printed. */
async function pyric(app: App, args: string[]): Promise<string> {
  const { output } = await app.serverScript('pyric.mjs', args);
  return output;
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page and sign in', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'repro' in window);
    await page.evaluate(() => repro.signIn());
    return page;
  });

  await app.step('the page writes a lobby to the default instance and to shard-00', () =>
    page.evaluate(() => repro.writeLobbies()));

  await app.step('pyric database get --instance shard-00 reads only the shard', async () => {
    const output = await pyric(app, ['database', 'get', '--instance', 'shard-00', '--path', 'rooms/lobby']);
    assert.match(output, /hosted sandbox/, output);
    assert.match(output, /"name": "shard lobby"/, output);
    assert.doesNotMatch(output, /default lobby/, output);
  });

  await app.step('the shard URL selects the same instance', async () => {
    const output = await pyric(app, ['database', 'get', '--instance', 'https://shard-00.firebaseio.com', '--path', 'rooms/lobby']);
    assert.match(output, /"name": "shard lobby"/, output);
  });

  await app.step('pyric database get --instance default reads the default instance', async () => {
    const output = await pyric(app, ['database', 'get', '--instance', 'default', '--path', 'rooms/lobby']);
    assert.match(output, /"name": "default lobby"/, output);
    assert.doesNotMatch(output, /shard lobby/, output);
  });

  await app.step('the project default instance name reads the default instance', async () => {
    const output = await pyric(app, ['database', 'get', '--instance', 'demo-app-default-rtdb', '--path', 'rooms/lobby']);
    assert.match(output, /"name": "default lobby"/, output);
  });

  await app.step('pyric database set --instance shard-00 writes where the page reads the shard', async () => {
    await pyric(app, ['database', 'set', '--instance', 'shard-00', '--path', 'rooms/agent', '--value', '{"name":"agent room"}']);
    const read = await page.evaluate(() => repro.read('rooms/agent'));
    assert.deepEqual(read, { default: null, shard: { name: 'agent room' } });
  });

  await app.step('an instance the project does not have is refused with the known instances', async () => {
    await assert.rejects(
      pyric(app, ['database', 'get', '--instance', 'shard-09', '--path', 'rooms/lobby']),
      (error: Error) => {
        assert.match(error.message, /exited with code 2/, error.message);
        assert.match(error.message, /database instance "shard-09" is not declared in firebase\.json/, error.message);
        assert.match(error.message, /demo-app-default-rtdb \(default\)/, error.message);
        assert.match(error.message, /shard-00/, error.message);
        return true;
      },
    );
  });
});
