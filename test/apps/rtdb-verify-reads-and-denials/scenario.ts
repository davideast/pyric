// A page writes, reads once, and listens to its own profile on the Node host,
// and the rules deny its write to another user's profile. The installed
// `pyric verify` then replays the session the host captured: clean under the
// rules it ran with, `now-allowed` for the denied write under rules that open
// it, and `now-denied` for the read and the listener under rules that drop
// `.read`. Before this, RTDB verify checked only allowed writes and query
// reads, so loosened rules and lost reads passed. The page also registers an
// `onDisconnect` and is denied a multi-path update: verify decides the
// registration as of when it was made, and the update as one request with
// both of its paths.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

interface Repro {
  signIn(): Promise<string>;
  useOwnProfile(): Promise<void>;
  writeOtherProfile(): Promise<string>;
  registerPresence(): Promise<void>;
  updateBothProfiles(): Promise<string>;
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

interface CapturedEvent { kind?: string; service?: string; method?: string; result?: string; path?: string }

/** Wait until the host's capture holds the session's listener attach and its denied write. */
async function waitForCapture(app: App): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    let events: CapturedEvent[] = [];
    try {
      const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
      events = (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'rtdb');
    } catch {
      // The host has not written the capture yet.
    }
    const listened = events.some((event) => event.method === 'listen' && event.result === 'allow');
    const denied = events.some((event) => event.method === 'set' && event.result === 'deny');
    const registered = events.some((event) => event.method === 'onDisconnect.set' && event.result === 'allow');
    const updateDenied = events.some((event) => event.method === 'update' && event.result === 'deny');
    if (listened && denied && registered && updateDenied) return;
    if (Date.now() > deadline) throw new Error('.pyric/last-session.json has no allowed listen, denied set, onDisconnect.set and denied update after 15s');
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

  await app.step('the page writes, reads, and listens to its own profile', () =>
    page.evaluate(() => repro.useOwnProfile()));

  await app.step('the rules deny the page a write to another profile', async () => {
    assert.match(await page.evaluate(() => repro.writeOtherProfile()), /PERMISSION_DENIED|permission/i);
  });

  await app.step('the page registers its presence onDisconnect', () => page.evaluate(() => repro.registerPresence()));

  await app.step('the rules deny an update to its own and another profile as one request', async () => {
    assert.match(await page.evaluate(() => repro.updateBothProfiles()), /PERMISSION_DENIED|permission/i);
  });

  await app.step('the host captures the listener, the registration, and the denials', () => waitForCapture(app));

  await app.step('the host records the registration exactly once', () => {
    const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
    const registrations = (capture.events ?? []).filter((event) => event.kind === 'operation' && event.method === 'onDisconnect.set');
    assert.equal(registrations.length, 1, JSON.stringify(registrations));
  });

  await app.step('pyric verify replays cleanly under the rules the session ran with', async () => {
    const output = await pyric(app, ['verify']);
    assert.match(output, /all selected services replay cleanly/, output);
    assert.doesNotMatch(output, /now-allowed|now-denied|state-drift/, output);
  });

  await app.step('rules that open every write report the denied write as now-allowed', async () => {
    app.writeFile('open.rules.json', JSON.stringify({ rules: { '.read': 'auth != null', '.write': true } }));
    const output = await pyricFails(app, ['verify', '--rules', 'rtdb=open.rules.json'], 1);
    assert.match(output, /\[rtdb\] now-allowed: set \/profiles\/someone-else\/name/, output);
    assert.match(output, /\[rtdb\] now-allowed: update \/profiles\/someone-else\/name/, output);
    assert.doesNotMatch(output, /now-denied/, output);
  });

  await app.step('rules that open the other profile but close its own keep the update denied, as one request', async () => {
    app.writeFile('other-open.rules.json', JSON.stringify({
      rules: {
        profiles: {
          'someone-else': { '.write': true },
          $uid: { '.read': 'auth != null && auth.uid === $uid', '.write': false },
        },
        presence: { $uid: { '.write': 'auth != null && auth.uid === $uid' } },
      },
    }));
    const output = await pyricFails(app, ['verify', '--rules', 'rtdb=other-open.rules.json'], 1);
    // The single-path write to the other profile is now allowed; the update is
    // not, because its path to the page's own profile is now denied.
    assert.match(output, /now-allowed: set \/profiles\/someone-else\/name/, output);
    assert.doesNotMatch(output, /now-allowed: update/, output);
  });

  await app.step('rules that lock presence report the onDisconnect registration as now-denied', async () => {
    app.writeFile('no-presence.rules.json', JSON.stringify({
      rules: {
        profiles: { $uid: { '.read': 'auth != null && auth.uid === $uid', '.write': 'auth != null && auth.uid === $uid' } },
        presence: { '.write': false },
      },
    }));
    const output = await pyricFails(app, ['verify', '--rules', 'rtdb=no-presence.rules.json'], 1);
    assert.match(output, /\[rtdb\] now-denied: onDisconnect\.set \/presence\//, output);
  });

  await app.step('rules that drop .read report the read and the listener as now-denied', async () => {
    app.writeFile('writes-only.rules.json', JSON.stringify({
      rules: { profiles: { $uid: { '.write': 'auth != null && auth.uid === $uid' } } },
    }));
    const output = await pyricFails(app, ['verify', '--rules', 'rtdb=writes-only.rules.json'], 1);
    assert.match(output, /\[rtdb\] now-denied: get \/profiles\//, output);
    assert.match(output, /\[rtdb\] now-denied: listen \/profiles\//, output);
    assert.doesNotMatch(output, /now-allowed/, output);
  });
});
