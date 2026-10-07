/**
 * Multiple RTDB instances on the served host, through the served
 * `firebase/database` entry. Every case runs the page's SDK calls over a port
 * to the host dispatch that both the SharedWorker and the Node host run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as sandboxDatabase from 'pyric/database';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import * as client from '../../../src/serve/worker/index.js';
import { rpc } from '../../../src/serve/worker/client/core.js';
import { type FakePort, makeHostCtx, portPair, sleep } from './integration-support.js';

/** Production's two-instance behavior, captured by the RTDB deploy-observe-restore runner. */
const observed = JSON.parse(readFileSync(new URL(
  '../../../../conformance/observations/rtdb-modular/rtdb-modular-multiple-instances.json',
  import.meta.url,
), 'utf8')) as {
  behavior: {
    rules: { default: Record<string, unknown>; second: Record<string, unknown> };
    signedOut: Record<string, string>;
    isolation: Record<string, unknown>;
    signedIn: Record<string, string>;
    isolationAfterBothWrites: Record<string, unknown>;
    sdk: Record<string, unknown>;
  };
};

const PROJECT = 'served-instances';
const DEFAULT_URL = `https://${PROJECT}-default-rtdb.firebaseio.com`;
const FIRST_URL = 'https://first-instance.firebaseio.com';
const SECOND_URL = 'https://second-instance.europe-west1.firebasedatabase.app';

function serveHost(ctx: HostCtx): void {
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port: FakePort;
    addEventListener() {}
    constructor(_url: unknown, _opts: unknown) {
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = {
        postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
      };
      hostPort.onmessage = (event) => {
        void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
      };
      this.port = clientPort;
    }
  };
}

async function servedApp(ctx: HostCtx) {
  serveHost(ctx);
  const database = await import('../../../src/serve/entries/database.js');
  const app = createAppForSandbox(ctx.sandbox, { projectId: PROJECT }, `served-instances-${Math.random()}`);
  return { database, app };
}

describe('served RTDB instances', () => {
  let restoreSharedWorker: () => void;
  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSharedWorker());

  it('keeps each instance\'s data and listeners apart, and shares the default store with its URL', async () => {
    const ctx = await makeHostCtx();
    for (const name of ['first-instance', 'second-instance']) {
      expect(setDatabaseRules(ctx, name, { rules: { '.read': true, '.write': true } }).ok).toBe(true);
    }
    const { database, app } = await servedApp(ctx);
    const first = database.getDatabase(app, FIRST_URL);
    const second = database.getDatabase(app, SECOND_URL);
    expect(second).not.toBe(first);
    expect(database.getDatabase(app, FIRST_URL)).toBe(first);
    // As in production, one app opens an instance once: a second URL form
    // naming the open default instance is refused.
    database.getDatabase(app);
    expect(() => database.getDatabase(app, DEFAULT_URL)).toThrow(
      'FIREBASE FATAL ERROR: Database initialized multiple times. Please make sure the format of the database URL matches with each database() call. ',
    );
    expect(() => database.getDatabase(app, 'https://first-instance.firebaseio.com/')).toThrow('Database initialized multiple times');

    const secondValues: unknown[] = [];
    const stop = database.onValue(database.ref(second, 'shared/probe'), (snapshot) => {
      secondValues.push(snapshot.val());
    });
    await sleep();
    await database.set(database.ref(first, 'shared/probe'), 'first');
    await sleep();
    expect(secondValues).toEqual([null]);
    expect((await database.get(database.ref(second, 'shared/probe'))).exists()).toBe(false);
    expect((await database.get(database.ref(database.getDatabase(app), 'shared/probe'))).exists()).toBe(false);

    await database.set(database.ref(second, 'shared/probe'), 'second');
    await sleep();
    expect(secondValues).toEqual([null, 'second']);
    expect((await database.get(database.ref(first, 'shared/probe'))).val()).toBe('first');
    stop();

    // Another app that names the default instance by URL shares its store.
    const urlApp = createAppForSandbox(ctx.sandbox, { projectId: PROJECT }, `served-instances-url-${Math.random()}`);
    await database.set(database.ref(database.getDatabase(urlApp, DEFAULT_URL), 'shared/probe'), 'default');
    expect((await database.get(database.ref(database.getDatabase(app), 'shared/probe'))).val()).toBe('default');
    await deleteApp(urlApp);

    // The host holds one sandbox store per instance; the default URL is the default instance.
    const hostFirst = sandboxDatabase.getAdminDatabase(ctx.sandbox, 'first-instance');
    const hostDefault = sandboxDatabase.getAdminDatabase(ctx.sandbox);
    expect((await sandboxDatabase.get(sandboxDatabase.ref(hostFirst, 'shared/probe'))).val()).toBe('first');
    expect((await sandboxDatabase.get(sandboxDatabase.ref(hostDefault, 'shared/probe'))).val()).toBe('default');
    await deleteApp(app);
  });

  it('enforces each instance\'s own rules, with one signed-in user\'s auth on both', async () => {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, 'first-instance', { rules: { '.read': 'auth != null', '.write': 'auth != null' } });
    setDatabaseRules(ctx, 'second-instance', {
      rules: { users: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } },
    });
    const { database, app } = await servedApp(ctx);
    const first = database.getDatabase(app, FIRST_URL);
    const second = database.getDatabase(app, SECOND_URL);

    await expect(database.get(database.ref(first, 'open'))).rejects.toThrow(/permission.denied/i);
    await expect(database.set(database.ref(second, 'users/someone'), 1)).rejects.toThrow(/permission.denied/i);

    const auth = client.getAuth(await import('../../../src/serve/entries/app-client.js')
      .then(({ workerClientForApp }) => workerClientForApp(app)));
    const { user } = await client.signInAnonymously(auth);
    await database.set(database.ref(first, 'open'), 'signed in');
    await database.set(database.ref(second, `users/${user.uid}`), 'own');
    await expect(database.set(database.ref(second, 'users/someone'), 1)).rejects.toThrow(/permission.denied/i);
    // The first instance's rules do not reach the second.
    await expect(database.get(database.ref(second, 'open'))).rejects.toThrow(/permission.denied/i);

    const status = await rpc(auth.port, {
      t: 'op', id: 'status', method: 'getActiveRules', service: 'database', instance: 'second-instance',
    }) as { source: unknown };
    expect(status.source).toEqual({ rules: { users: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } } });
    await deleteApp(app);
  });

  it('reports each instance\'s URL as production does', async () => {
    const ctx = await makeHostCtx();
    const { database, app } = await servedApp(ctx);
    const first = database.getDatabase(app, FIRST_URL);
    const second = database.getDatabase(app, SECOND_URL);
    expect(first.app).toBe(app);
    expect(database.ref(first).toString()).toBe('https://first-instance.firebaseio.com/');
    expect(database.ref(first, 'a/b c').toString()).toBe('https://first-instance.firebaseio.com/a/b%20c');
    expect(database.ref(second, 'a').toString()).toBe('https://second-instance.europe-west1.firebasedatabase.app/a');
    expect(database.ref(database.getDatabase(app), 'a').toJSON()).toBe(`${DEFAULT_URL}/a`);
    expect(database.refFromURL(first, 'https://first-instance.firebaseio.com/a/b').toString())
      .toBe('https://first-instance.firebaseio.com/a/b');
    expect(() => database.refFromURL(first, 'https://second-instance.firebaseio.com/a')).toThrow(
      'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found second-instance.firebaseio.com but expected first-instance.firebaseio.com) ',
    );
    expect(() => database.getDatabase(app, 'https://first-instance.firebaseio.com/child')).toThrow(
      'FIREBASE FATAL ERROR: Database URL must point to the root of a Firebase Database (not including a child path). ',
    );
    expect(database.ref(first, 'a').isEqual(database.ref(second, 'a'))).toBe(false);
    await deleteApp(app);
  });

  it('replays the production observation of two instances with different rules and one user', async () => {
    const { rules, signedOut, isolation, signedIn, isolationAfterBothWrites } = observed.behavior;
    const ctx = await makeHostCtx();
    // Production's root rules on both instances are `false`; the capture's
    // rules sit under a run-scoped key, here `run`.
    for (const [instance, subtree] of [[undefined, rules.default], ['second-instance', rules.second]] as const) {
      setDatabaseRules(ctx, instance, { rules: { '.read': false, '.write': false, run: subtree } });
    }
    const { database, app } = await servedApp(ctx);
    const defaultDb = database.getDatabase(app);
    const secondDb = database.getDatabase(app, 'https://second-instance.firebaseio.com');
    const verdict = (operation: Promise<unknown>) => operation.then(() => 'ALLOW', () => 'DENY');
    const hostValue = async (instance: string | undefined, path: string) =>
      (await sandboxDatabase.get(sandboxDatabase.ref(sandboxDatabase.getAdminDatabase(ctx.sandbox, instance), path))).val();

    expect({
      defaultWrite: await verdict(database.set(database.ref(defaultDb, 'run/open/probe'), 'default')),
      secondWrite: await verdict(database.set(database.ref(secondDb, 'run/open/probe'), 'second')),
    }).toEqual(signedOut);
    expect({
      secondWriteReadOnSecond: await hostValue('second-instance', 'run/open/probe'),
      secondWriteReadOnDefault: await hostValue(undefined, 'run/open/probe'),
    }).toEqual(isolation);

    const { workerClientForApp } = await import('../../../src/serve/entries/app-client.js');
    const { user } = await client.signInAnonymously(client.getAuth(workerClientForApp(app)));
    expect({
      defaultWrite: await verdict(database.set(database.ref(defaultDb, 'run/open/probe'), 'default')),
      secondOwnUserPath: await verdict(database.set(database.ref(secondDb, `run/users/${user.uid}`), 'own')),
      secondOtherUserPath: await verdict(database.set(database.ref(secondDb, 'run/users/another-user'), 'other')),
      secondPathWithoutRules: await verdict(database.get(database.ref(secondDb, 'run/closed'))),
      defaultReadOfSecondOnlyPath: await verdict(database.get(database.ref(defaultDb, `run/users/${user.uid}`))),
    }).toEqual(signedIn);
    expect({
      defaultHolds: await hostValue(undefined, 'run/open/probe'),
      secondHolds: await hostValue('second-instance', 'run/open/probe'),
      secondUserPathOnDefault: await hostValue(undefined, `run/users/${user.uid}`),
    }).toEqual(isolationAfterBothWrites);
    await deleteApp(app);
  });

  it('locks an instance firebase.json deploys no rules to, and says how to deploy them once', async () => {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, 'first-instance', { rules: { '.read': true, '.write': true } });
    const { database, app } = await servedApp(ctx);
    const notices: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('pyric: RTDB')) notices.push(line);
    };
    try {
      await database.set(database.ref(database.getDatabase(app, FIRST_URL), 'a'), 1);
      const locked = database.getDatabase(app, 'https://second-instance.firebaseio.com');
      await expect(database.get(database.ref(locked, 'a'))).rejects.toThrow(/permission.denied/i);
      await expect(database.set(database.ref(locked, 'a'), 1)).rejects.toThrow(/permission.denied/i);
      const cancelled = await new Promise<unknown>((resolve) => {
        database.onValue(database.ref(locked, 'a'), () => resolve('delivered'), resolve);
      });
      expect(String(cancelled)).toMatch(/permission.denied/i);
      expect(notices).toEqual([
        'pyric: RTDB instance "second-instance" has no rules in firebase.json; it denies all reads and writes. Add {"instance": "second-instance", "rules": "<file>"} to the database array.',
      ]);
    } finally {
      console.warn = warn;
    }
    await deleteApp(app);
  });

  it('replays the production SDK\'s handle and reference identity across instances', async () => {
    const sdk = observed.behavior.sdk;
    const ctx = await makeHostCtx();
    serveHost(ctx);
    const database = await import('../../../src/serve/entries/database.js');
    const app = createAppForSandbox(ctx.sandbox, { projectId: 'sdk-project' }, `served-instances-sdk-${Math.random()}`);
    const noProject = createAppForSandbox(ctx.sandbox, { apiKey: 'unused' }, `served-instances-sdk-none-${Math.random()}`);
    const outcome = (run: () => unknown) => {
      try {
        const value = run();
        return { value: typeof value === 'string' ? value : 'returned' };
      } catch (error) {
        return { error: (error as Error).message };
      }
    };
    const defaultDb = database.getDatabase(app);
    const second = database.getDatabase(app, 'https://second.firebaseio.com');
    expect({
      referenceUrls: {
        defaultRoot: database.ref(defaultDb).toString(),
        secondPath: database.ref(second, 'a b/c').toString(),
        regional: database.ref(database.getDatabase(app, 'https://reg.europe-west1.firebasedatabase.app'), 'a').toString(),
        namespaceQuery: database.ref(database.getDatabase(app, 'https://host.firebaseio.com?ns=named'), 'a').toString(),
      },
      sameArgumentSameHandle: database.getDatabase(app, 'https://second.firebaseio.com') === second,
      defaultUrlAfterDefault: outcome(() => database.getDatabase(app, 'https://sdk-project-default-rtdb.firebaseio.com')),
      trailingSlashAfterOpen: outcome(() => database.getDatabase(app, 'https://second.firebaseio.com/')),
      refFromUrlSameHost: outcome(() => database.refFromURL(second, 'https://second.firebaseio.com/a/b%20c').toString()),
      refFromUrlOtherHost: outcome(() => database.refFromURL(second, 'https://third.firebaseio.com/a')),
      noProjectNoUrl: outcome(() => database.getDatabase(noProject)),
    }).toEqual(sdk);
    await deleteApp(app);
    await deleteApp(noProject);
  });

  it('throws as the SDK does when neither a URL nor a project id names the instance', async () => {
    const ctx = await makeHostCtx();
    serveHost(ctx);
    const database = await import('../../../src/serve/entries/database.js');
    const app = createAppForSandbox(ctx.sandbox, { apiKey: 'unused' }, `served-instances-no-project-${Math.random()}`);
    expect(() => database.getDatabase(app)).toThrow(
      "FIREBASE FATAL ERROR: Can't determine Firebase Database URL. Be sure to include  a Project ID when calling firebase.initializeApp(). ",
    );
    await deleteApp(app);
  });
});

