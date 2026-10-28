// A page writes to a named RTDB instance and to the default instance on the
// Node host. `pyric database <method> --instance <name>` then runs as a
// process against that host: it reads and writes only the instance it names,
// accepts a name, a URL, or `default`, and refuses an instance the project
// does not have. `pyric verify` then replays the session the host captured,
// each instance against its own rules, and names an instance it has no rules
// for (#967).
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

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

/** Run `pyric` expecting it to fail with `code`, and return what it printed. */
async function pyricFails(app: App, args: string[], code: number): Promise<string> {
  let output: string | undefined;
  await assert.rejects(pyric(app, args), (error: Error) => {
    assert.match(error.message, new RegExp(`exited with code ${code}`), error.message);
    output = error.message;
    return true;
  });
  return output ?? '';
}

interface CapturedEvent { kind?: string; service?: string; instance?: string; path?: string }

/** Wait until the host's capture holds a commit at `path` on each of the default instance and `instance`. */
async function waitForCapture(app: App, path: string, instance: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    let commits: CapturedEvent[] = [];
    try {
      const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
      commits = (capture.events ?? []).filter((event) => event.kind === 'commit' && event.service === 'rtdb' && event.path?.replace(/^\//, '') === path);
    } catch {
      // The host has not written the capture yet.
    }
    const onDefault = commits.some((event) => event.instance === undefined);
    const onInstance = commits.some((event) => event.instance === instance);
    if (onDefault && onInstance) return;
    if (Date.now() > deadline) throw new Error(`.pyric/last-session.json has no commit at ${path} on the default instance and on ${instance} after 15s`);
    await sleep(250);
  }
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

  await app.step('the host captures the session, with the shard write named by its instance', () =>
    waitForCapture(app, 'rooms/lobby', 'shard-00'));

  await app.step('pyric verify replays each instance against its firebase.json rules', async () => {
    const output = await pyric(app, ['verify']);
    assert.match(output, /all selected services replay cleanly/, output);
    assert.doesNotMatch(output, /state-drift|now-denied/, output);
  });

  await app.step('stricter shard rules deny only the shard write, tagged with the instance', async () => {
    app.writeFile('shard.strict.rules.json', JSON.stringify({ rules: { '.read': 'auth != null', '.write': false } }));
    const output = await pyricFails(app, ['verify', '--rules', 'rtdb:shard-00=shard.strict.rules.json'], 1);
    assert.match(output, /\[rtdb shard-00\] now-denied: set \/?rooms\/lobby/, output);
    // The denied write never lands, so only the shard's tree may drift; the
    // default instance, under its unchanged rules, reports nothing.
    assert.doesNotMatch(output, /\[rtdb\] /, output);
    assert.match(output, /rtdb:shard-00=shard\.strict\.rules\.json/, output);
  });

  await app.step('pyric verify --json reports the denial with its instance', async () => {
    const output = await pyricFails(app, ['verify', '--json', '--rules', 'rtdb:shard-00=shard.strict.rules.json'], 1);
    const report = JSON.parse(output.slice(output.indexOf('{'))) as {
      rulesPaths: Record<string, string>;
      results: Array<{ services: { rtdb: { divergences: Array<{ kind: string; instance?: string; path?: string }> } } }>;
    };
    assert.match(report.rulesPaths['rtdb:shard-00'] ?? '', /shard\.strict\.rules\.json$/, output);
    assert.match(report.rulesPaths.rtdb ?? '', /database\.rules\.json$/, output);
    const divergences = report.results[0]?.services.rtdb.divergences ?? [];
    const denied = divergences.filter((divergence) => divergence.kind === 'now-denied');
    assert.deepEqual(denied.map(({ instance, path }) => ({ instance, path: path?.replace(/^\//, '') })), [{ instance: 'shard-00', path: 'rooms/lobby' }], output);
    assert.ok(divergences.every((divergence) => divergence.instance === 'shard-00'), output);
  });

  await app.step('rules for an instance the session never used are refused with the recorded instances', async () => {
    const output = await pyricFails(app, ['verify', '--rules', 'rtdb:shard-09=shard.strict.rules.json'], 2);
    assert.match(output, /--rules rtdb:shard-09: the session never used instance "shard-09"/, output);
    assert.match(output, /Instances the session used: the default instance, shard-00\./, output);
  });

  await app.step('a recorded instance without candidate rules is an error that names it', async () => {
    app.writeFile('firebase.json', JSON.stringify({
      database: [{ instance: 'demo-app-default-rtdb', rules: 'database.rules.json' }],
    }, null, 2));
    const output = await pyricFails(app, ['verify'], 2);
    assert.match(output, /missing candidate rtdb rules for instance "shard-00", which the session used/, output);
    assert.match(output, /--rules rtdb:shard-00=<path>/, output);
  });
});
