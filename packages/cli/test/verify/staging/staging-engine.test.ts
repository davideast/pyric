import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  equalTo,
  get,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  onDisconnect,
  onValue,
  orderByChild,
  query,
  ref,
  set,
  update,
  sandbox as rtdbSandbox,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

import { parseArgs } from '../../../src/cli/parse-args.js';
import { runVerify } from '../../../src/cli/verify.js';
import { buildVerifyFixture, verifyFixture, type PyricVerifyFixture } from '../../../src/verify/index.js';
import { stagingMarker, StagingSafetyError } from '../../../src/verify/staging/engine.js';
import { RtdbRestClient } from '../../../src/verify/staging/rest.js';
import { assertNotAppInstance, stagingTargetFrom, stagingToken } from '../../../src/verify/staging/target.js';
import { fakeRtdbRest, type FakeRtdbRest } from './fake-rtdb-rest.js';

const RULES = {
  rules: {
    profiles: { $uid: { '.read': 'auth != null && auth.uid === $uid', '.write': 'auth != null && auth.uid === $uid' } },
    presence: { $uid: { '.write': 'auth != null && auth.uid === $uid' } },
    items: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid", '.indexOn': ['owner'] },
  },
};
const OPEN = { rules: { '.read': 'auth != null', '.write': true, items: { '.indexOn': ['owner'] } } };
const TIGHT = { rules: { profiles: { $uid: { '.write': 'auth != null && auth.uid === $uid' } }, presence: { '.write': false } } };
const DENY_ALL_TEXT = '{\n  "rules": {\n    ".read": false,\n    ".write": false\n  }\n}';
const ENROLLED = `${stagingMarker('demo-staging', new Date(0))}\n${DENY_ALL_TEXT}`;
const URL_ = 'https://demo-verify.firebaseio.com';

/** A session: alice writes, reads, listens, queries, registers presence, and is denied a write and an update. */
async function captureSession(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  rtdbSandbox.setRules(getDatabase(sandbox), RULES);
  rtdbSandbox.setData(getAdminDatabase(sandbox), { '/profiles/bob': { name: 'Bob' }, '/items/a': { owner: 'alice' } });
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  await set(ref(db, 'profiles/alice'), { name: 'me' });
  await get(ref(db, 'profiles/alice'));
  const off = onValue(ref(db, 'profiles/alice'), () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  off();
  await get(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice'), limitToFirst(5)));
  await onDisconnect(ref(db, 'presence/alice')).set('offline');
  await set(ref(db, 'profiles/bob/name'), 'mallory').catch(() => {});
  await update(ref(db), { 'profiles/alice/name': 'again', 'profiles/bob/name': 'mallory' }).catch(() => {});
  const fixture = buildVerifyFixture({ sandbox, rtdbRules: RULES, rtdbState: rtdbSandbox.snapshotState(getAdminDatabase(sandbox)) });
  return JSON.parse(JSON.stringify(fixture)) as PyricVerifyFixture;
}

function staging(fake: FakeRtdbRest) {
  return { client: new RtdbRestClient(URL_, async () => 'token', fake.fetch), projectId: 'demo-staging' };
}

const summary = (divergences: Array<{ kind: string; method?: string; path?: string }>) =>
  divergences.map(({ kind, method, path }) => `${kind} ${method ?? ''} ${path ?? ''}`.trim());

describe('the staging engine', () => {
  it('replays a session cleanly under the rules it ran with, and leaves the instance as it found it', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    const result = await verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: staging(fake) });
    expect(summary(result.services.rtdb?.engines?.staging?.divergences ?? [])).toEqual([]);
    expect(result.services.rtdb?.engines?.staging?.checkedEvents).toBe(7);
    expect(result.ok).toBe(true);
    expect(fake.rulesText()).toBe(ENROLLED);
    expect(rtdbSandbox.snapshotState(getAdminDatabase(fake.sandbox))).toEqual({});
  });

  it('reports now-allowed for the denials open rules allow, and puts each landed write back', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    const result = await verifyFixture(await captureSession(), { rules: { rtdb: OPEN }, engines: ['staging'], staging: staging(fake) });
    expect(summary(result.services.rtdb?.divergences ?? [])).toEqual([
      'now-allowed set /profiles/bob/name',
      'now-allowed update /profiles/bob/name',
    ]);
    expect(result.ok).toBe(false);
    expect(fake.requests).toContainEqual(expect.stringMatching(/^PUT \/profiles\/bob\/name\?auth_variable_override=/));
  });

  it('reports now-denied for the reads and the registration tight rules deny', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    const result = await verifyFixture(await captureSession(), { rules: { rtdb: TIGHT }, engines: ['staging'], staging: staging(fake) });
    expect(summary(result.services.rtdb?.divergences ?? [])).toEqual([
      'now-denied get /profiles/alice',
      'now-denied listen /profiles/alice',
      'now-denied get /items',
      'now-denied onDisconnect.set /presence/alice',
    ]);
  });

  it('sends a captured query as REST query parameters', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    await verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: staging(fake) });
    const read = fake.requests.find((request) => request.startsWith('GET /items?'));
    const params = new URLSearchParams(read?.slice(read.indexOf('?')));
    expect(params.get('orderBy')).toBe('"owner"');
    expect(params.get('equalTo')).toBe('"alice"');
    expect(params.get('limitToFirst')).toBe('5');
    expect(JSON.parse(params.get('auth_variable_override') ?? 'null')).toMatchObject({ uid: 'alice' });
  });

  it('reports engine-drift where production and the sandbox decide an operation differently', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    fake.force((method, path) => method === 'GET' && path === '/profiles/alice', 401);
    const result = await verifyFixture(await captureSession(), {
      rules: { rtdb: RULES }, engines: ['sandbox', 'staging'], staging: staging(fake),
    });
    expect(result.services.rtdb?.engines?.sandbox?.divergences).toEqual([]);
    expect(result.services.rtdb?.engines?.staging?.divergences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'engine-drift', method: 'get', path: '/profiles/alice', sandbox: 'unchanged', staging: 'now-denied' }),
    ]));
    expect(result.ok).toBe(false);
  });

  it('reports candidate rules production refuses to deploy, and restores the instance', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    fake.refuseRules('Error saving rules - Line 1: some production-only refusal.');
    const result = await verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: staging(fake) });
    expect(result.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'unsupported', reason: expect.stringContaining('production refused to deploy the candidate rules for the default instance: Error saving rules') }),
    ]);
    expect(result.ok).toBe(false);
    expect(fake.rulesText()).toBe(ENROLLED);
  });

  it('reports a captured query production cannot serve without an index as unsupported, with production\'s message', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    const noIndex = { rules: { ...RULES.rules, items: { '.read': true } } };
    const result = await verifyFixture(await captureSession(), { rules: { rtdb: noIndex }, engines: ['staging'], staging: staging(fake) });
    expect(result.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'unsupported', method: 'get', path: '/items', reason: expect.stringMatching(/HTTP 400.*[Ii]ndex/) }),
    ]);
  });

  it('refuses an instance that is not enrolled, without changing it', async () => {
    const fake = fakeRtdbRest({ rulesText: DENY_ALL_TEXT });
    await expect(verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: staging(fake) }))
      .rejects.toThrow(/not enrolled for staging verification/);
    expect(fake.rulesText()).toBe(DENY_ALL_TEXT);
    expect(fake.requests.every((request) => request.startsWith('GET'))).toBe(true);
  });

  it('refuses an enrolled instance that holds data, without changing it', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED, data: { '/keep/me': 1 } });
    await expect(verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: staging(fake) }))
      .rejects.toThrow(StagingSafetyError);
    expect(rtdbSandbox.snapshotState(getAdminDatabase(fake.sandbox))).toEqual({ keep: { me: 1 } });
    expect(fake.requests.every((request) => request.startsWith('GET'))).toBe(true);
  });

  it('refuses an instance enrolled for another project', async () => {
    const fake = fakeRtdbRest({ rulesText: `${stagingMarker('someone-else', new Date(0))}\n${DENY_ALL_TEXT}` });
    await expect(verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: staging(fake) }))
      .rejects.toThrow(/enrolled for project someone-else, not demo-staging/);
  });

  it('fails loudly when the instance cannot be put back', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    const client = new RtdbRestClient(URL_, async () => 'token', async (url, init) => {
      // Let the candidate deploy through, then fail the restore.
      if (url.endsWith('/.settings/rules.json') && init.method === 'PUT' && init.body?.includes('pyric verify staging')) {
        return { status: 503, text: async () => '{"error":"unavailable"}' };
      }
      return fake.fetch(url, init);
    });
    await expect(verifyFixture(await captureSession(), { rules: { rtdb: RULES }, engines: ['staging'], staging: { client, projectId: 'demo-staging' } }))
      .rejects.toThrow(/was not left as it was found \(rules restored: false/);
  });

  it('is RTDB-only', async () => {
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    await expect(verifyFixture(await captureSession(), {
      rules: { rtdb: RULES, firestore: "rules_version = '2';\nservice cloud.firestore {}" },
      services: ['firestore', 'rtdb'], engines: ['staging'], staging: staging(fake),
    })).rejects.toThrow(/the staging engine checks RTDB only/);
  });
});

describe('the staging target', () => {
  it('reads pyric.json verify.staging, and resolves an instance name to its URL', () => {
    expect(stagingTargetFrom({ verify: { staging: { project: 'p', rtdb: 'my-verify' } } })).toEqual({
      projectId: 'p', databaseUrl: 'https://my-verify.firebaseio.com', instance: 'my-verify',
    });
    expect(stagingTargetFrom({ verify: { staging: { project: 'p', rtdb: 'https://x.europe-west1.firebasedatabase.app/' } } }).databaseUrl)
      .toBe('https://x.europe-west1.firebasedatabase.app');
    expect(() => stagingTargetFrom({})).toThrow(/no staging target/);
    expect(() => stagingTargetFrom({ verify: { staging: { rtdb: 'x' } } })).toThrow(/verify.staging.project/);
  });

  it('refuses an instance the app deploys rules to, or the app project\'s default instance', () => {
    const target = stagingTargetFrom({ verify: { staging: { project: 'p', rtdb: 'app-db' } } });
    expect(() => assertNotAppInstance(target, { firebaseJson: { database: [{ instance: 'app-db', rules: 'r.json' }] } as never }))
      .toThrow(/the app uses it/);
    expect(() => assertNotAppInstance(target, { firebaseJson: null, targetInstances: ['app-db'] })).toThrow(/the app uses it/);
    const fallback = stagingTargetFrom({ verify: { staging: { project: 'p', rtdb: 'my-app-default-rtdb' } } });
    expect(() => assertNotAppInstance(fallback, { firebaseJson: null, appProjectId: 'my-app' })).toThrow(/the app uses it/);
    expect(() => assertNotAppInstance(stagingTargetFrom({ verify: { staging: { project: 'p', rtdb: 'verify-only' } } }), {
      firebaseJson: { database: [{ instance: 'app-db', rules: 'r.json' }] } as never, appProjectId: 'my-app',
    })).not.toThrow();
  });

  it('falls back to a fresh Firebase CLI token, and refuses a stale one', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-staging-token-')));
    try {
      const store = (expires: number) => {
        const dir = join(home, '.config', 'configstore');
        require('node:fs').mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'firebase-tools.json'), JSON.stringify({ tokens: { access_token: 'cli-token', expires_at: expires } }));
      };
      const failing = async () => { throw new Error('no service account or ADC'); };
      store(10_000_000);
      const fresh = await stagingToken('p', { resolve: failing as never, env: { HOME: home }, now: () => 0 });
      expect(fresh.source).toBe('firebase login');
      expect(await fresh.token()).toBe('cli-token');
      store(60_000);
      await expect(stagingToken('p', { resolve: failing as never, env: { HOME: home }, now: () => 0 })).rejects.toThrow(/no credentials for staging project p/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('pyric verify --engine staging and pyric verify staging init', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function run(dir: string, argv: string[], fake: FakeRtdbRest) {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
    const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const code = await runVerify(parseArgs(['verify', ...argv]), {
        resolveScope: (async () => ({ scope: { projectId: 'demo-staging', resolveToken: async () => 'token' }, source: 'adc' })) as never,
        stagingClient: (target, token) => new RtdbRestClient(target.databaseUrl, token, fake.fetch),
      });
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.chdir(previous);
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  async function project(): Promise<string> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-verify-staging-')));
    dirs.push(dir);
    writeFileSync(join(dir, 'pyric.json'), JSON.stringify({ verify: { staging: { project: 'demo-staging', rtdb: 'demo-verify' } } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
    writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(RULES));
    writeFileSync(join(dir, 'open.rules.json'), JSON.stringify(OPEN));
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureSession()));
    return dir;
  }

  it('enrolls an empty instance once, then verifies against it with both engines named per line', async () => {
    const dir = await project();
    const fake = fakeRtdbRest({ rulesText: DENY_ALL_TEXT });
    const refused = await run(dir, ['session.json', '--engine', 'staging'], fake);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/not enrolled for staging verification/);

    const init = await run(dir, ['staging', 'init'], fake);
    expect(init.code).toBe(0);
    expect(init.out).toMatch(/enrolled https:\/\/demo-verify\.firebaseio\.com \(project demo-staging, credentials: adc\)/);
    expect(fake.rulesText().startsWith('/* pyric verify staging:')).toBe(true);
    expect((await run(dir, ['staging', 'init'], fake)).out).toMatch(/already enrolled/);

    const clean = await run(dir, ['session.json', '--engine', 'sandbox', '--engine', 'staging'], fake);
    expect(clean.code).toBe(0);
    const opened = await run(dir, ['session.json', '--engine', 'sandbox', '--engine', 'staging', '--rules', 'rtdb=open.rules.json'], fake);
    expect(opened.code).toBe(1);
    expect(opened.out).toContain('[rtdb sandbox] now-allowed: set /profiles/bob/name');
    expect(opened.out).toContain('[rtdb staging] now-allowed: set /profiles/bob/name');
  });

  it('refuses to enroll an instance that holds data', async () => {
    const dir = await project();
    const fake = fakeRtdbRest({ rulesText: DENY_ALL_TEXT, data: { '/app/data': 1 } });
    const init = await run(dir, ['staging', 'init'], fake);
    expect(init.code).toBe(2);
    expect(init.err).toMatch(/refusing to enroll .* it holds data/);
    expect(fake.rulesText()).toBe(DENY_ALL_TEXT);
  });

  it('refuses a staging instance firebase.json deploys to', async () => {
    const dir = await project();
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: [{ instance: 'demo-verify', rules: 'database.rules.json' }] }));
    const fake = fakeRtdbRest({ rulesText: ENROLLED });
    const result = await run(dir, ['session.json', '--engine', 'staging'], fake);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/refusing staging instance demo-verify: the app uses it/);
    expect(fake.requests).toEqual([]);
  });
});
