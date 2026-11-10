/**
 * The live wrapper's project check. An observer that names the host's
 * project (`hostProjectId`) refuses every observed call and listener whose
 * app names another project: the wrapper throws `PYRIC_LIVE_REFUSED` before
 * the real function runs, and the observer gets no record. A call whose
 * project can't be read, and a call to the host's project, run as the app
 * called them. An app with no projectId names its project through the
 * default forms of its databaseURL, storageBucket and authDomain; a custom
 * domain or bucket encodes none and is not judged. A Realtime Database or
 * Cloud Storage call is also judged by the instance or bucket it reaches,
 * which `getDatabase(app, url)`, `getStorage(app, 'gs://...')` and
 * `ref(storage, 'gs://...')` can point away from the config. Each row is a
 * stand-in module, so a spy tells whether the real function ran.
 */
import { describe, expect, test } from 'bun:test';
import { wrapLiveModule, type LiveModuleSite } from '../src/modules.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';
import type { LiveClient } from '../src/refusal.js';
import * as refusal from '../src/refusal.js';

const { LIVE_REFUSED } = refusal;

const HOST = 'a';
const OTHER = 'b';

type Callback = (...args: unknown[]) => unknown;

/** The real functions a stand-in module exports, and the calls they got. */
interface StandIn {
  readonly module: Record<string, Callback>;
  readonly ran: string[];
}

function standIn(names: readonly string[], returned: (name: string) => unknown = () => Promise.resolve('real')): StandIn {
  const ran: string[] = [];
  const module: Record<string, Callback> = {};
  for (const name of names) {
    module[name] = () => {
      ran.push(name);
      return returned(name);
    };
  }
  return { module, ran };
}

function hostObserver(hostProjectId: string | undefined): { records: LiveCallRecord[]; observer: LiveObserver } {
  const records: LiveCallRecord[] = [];
  const record = (made: LiveCallRecord) => {
    records.push(made);
  };
  const observer: LiveObserver = Object.assign(record, hostProjectId === undefined ? {} : { hostProjectId, client: 'page' as const });
  return { records, observer };
}

function appOn(projectId: string | undefined): { options: Record<string, string> } {
  return { options: projectId === undefined ? { apiKey: 'key' } : { apiKey: 'key', projectId } };
}

/** An app with no projectId whose config holds only the given fields. */
function appWith(fields: Record<string, string>): { options: Record<string, string> } {
  return { options: { apiKey: 'key', ...fields } };
}

/** An app whose projectId is the host's, with the given fields beside it. */
function hostAppWith(fields: Record<string, string>): { options: Record<string, string> } {
  return { options: { apiKey: 'key', projectId: HOST, ...fields } };
}

/** The data a project refusal carries beside its message. */
type ProjectRefusalData = Error & { code?: string; field?: string; appProjectId?: string; hostProjectId?: string };

/** One call through a live row: the stand-in it wraps, and how the app makes the call on an app. */
interface RowCall {
  readonly row: string;
  readonly call: string;
  readonly make: (site: LiveModuleSite, app: unknown) => { readonly ran: string[]; readonly invoke: () => unknown };
  /**
   * The stand-in's call made no request, so production never answered it and
   * the row makes no record, as Messaging's `getToken` does when the realm saw
   * no Installations or FCM request.
   */
  readonly answersLocally?: true;
}

const noop = () => undefined;

/** The host's default RTDB instance and bucket, which every row reaches unless a test names another. */
const HOST_INSTANCE = `${HOST}-default-rtdb`;
const HOST_BUCKET = `${HOST}.firebasestorage.app`;

/**
 * A call through a stand-in Realtime Database row, on a reference to the
 * database the row noted from `getDatabase(app)`, as the SDK's repo is.
 * `namespace` is the instance the repo reaches.
 */
function databaseCall(
  site: LiveModuleSite,
  app: unknown,
  name: string,
  returned: () => unknown,
  call: (live: Record<string, Callback>, ref: unknown) => unknown,
  namespace: string = HOST_INSTANCE,
): { readonly ran: string[]; readonly invoke: () => unknown } {
  const repo = { repoInfo_: { namespace } };
  const real = standIn([name], returned);
  const module: Record<string, Callback> = { ...real.module, getDatabase: () => ({ app, _repoInternal: repo }) };
  const live = wrapLiveModule('live-database', 'firebase/database', module, site);
  // The Database is noted through a row whose observer names no host, so
  // `getDatabase` judges nothing here and the call under test is what is judged.
  const unjudged = wrapLiveModule('live-database', 'firebase/database', module, { ...site, observer: hostObserver(undefined).observer });
  unjudged.getDatabase!(app);
  const ref = { _repo: repo, _path: { toString: () => '/items' } };
  return { ran: real.ran, invoke: () => call(live, ref) };
}

/** A `getDownloadURL` through a stand-in Cloud Storage row, on a reference to `bucket`. */
function storageCall(site: LiveModuleSite, app: unknown, bucket: string): { readonly ran: string[]; readonly invoke: () => unknown } {
  const real = standIn(['getDownloadURL']);
  const live = wrapLiveModule('live-storage', 'firebase/storage', real.module, site);
  const ref = { storage: { app }, bucket, fullPath: 'images/a.png' };
  return { ran: real.ran, invoke: () => live.getDownloadURL!(ref) };
}

const ROW_CALLS: readonly RowCall[] = [
  {
    row: 'Firestore',
    call: 'getDoc',
    make: (site, app) => {
      const real = standIn(['getDoc']);
      const live = wrapLiveModule('live-firestore', 'firebase/firestore', real.module, site);
      return { ran: real.ran, invoke: () => live.getDoc!({ firestore: { app }, path: 'rooms/r1' }) };
    },
  },
  {
    row: 'Firestore',
    call: 'onSnapshot',
    make: (site, app) => {
      const real = standIn(['onSnapshot'], () => noop);
      const live = wrapLiveModule('live-firestore', 'firebase/firestore', real.module, site);
      return { ran: real.ran, invoke: () => live.onSnapshot!({ firestore: { app }, path: 'rooms/r1' }, noop) };
    },
  },
  {
    row: 'Realtime Database',
    call: 'get',
    make: (site, app) => databaseCall(site, app, 'get', () => Promise.resolve('real'), (live, ref) => live.get!(ref)),
  },
  {
    row: 'Realtime Database',
    call: 'onValue',
    make: (site, app) => databaseCall(site, app, 'onValue', () => noop, (live, ref) => live.onValue!(ref, noop)),
  },
  {
    row: 'Cloud Storage',
    call: 'getDownloadURL',
    make: (site, app) => storageCall(site, app, HOST_BUCKET),
  },
  {
    row: 'AI Logic',
    call: 'generateContent',
    make: (site, app) => {
      const ran: string[] = [];
      const model = {
        model: 'models/gemini-flash-lite-latest',
        generateContent: () => {
          ran.push('generateContent');
          return Promise.resolve({ response: {} });
        },
      };
      const standInAi: Record<string, Callback> = { getGenerativeModel: () => model };
      const live = wrapLiveModule('live-ai', 'firebase/ai', standInAi, site);
      const made = live.getGenerativeModel!({ app }) as typeof model;
      return { ran, invoke: () => made.generateContent() };
    },
  },
  {
    row: 'Auth',
    call: 'signInAnonymously',
    make: (site, app) => {
      const real = standIn(['signInAnonymously']);
      const live = wrapLiveModule('live-auth', 'firebase/auth', real.module, site);
      return { ran: real.ran, invoke: () => live.signInAnonymously!({ app }) };
    },
  },
  {
    row: 'Cloud Messaging',
    call: 'getToken',
    make: (site, app) => {
      const real = standIn(['getToken'], () => Promise.resolve('fcm-token'));
      const live = wrapLiveModule('live-messaging', 'firebase/messaging', real.module, site);
      return { ran: real.ran, invoke: () => live.getToken!({ app }, { vapidKey: 'vapid' }) };
    },
    answersLocally: true,
  },
  {
    row: 'Cloud Messaging',
    call: 'onMessage',
    make: (site, app) => {
      const real = standIn(['onMessage'], () => noop);
      const live = wrapLiveModule('live-messaging', 'firebase/messaging', real.module, site);
      return { ran: real.ran, invoke: () => live.onMessage!({ app }, noop) };
    },
  },
  {
    row: 'Cloud Messaging (service worker)',
    call: 'onBackgroundMessage',
    make: (site, app) => {
      const real = standIn(['onBackgroundMessage'], () => noop);
      const live = wrapLiveModule('live-messaging-sw', 'firebase/messaging/sw', real.module, site);
      return { ran: real.ran, invoke: () => live.onBackgroundMessage!({ app }, noop) };
    },
  },
  {
    row: 'App Check',
    call: 'initializeAppCheck',
    make: (site, app) => {
      const real = standIn(['initializeAppCheck'], () => ({ app }));
      const live = wrapLiveModule('live-app-check', 'firebase/app-check', real.module, site);
      return { ran: real.ran, invoke: () => live.initializeAppCheck!(app, { isTokenAutoRefreshEnabled: false }) };
    },
  },
  {
    row: 'App Check',
    call: 'getToken',
    make: (site, app) => {
      const real = standIn(['getToken'], () => Promise.resolve({ token: 'app-check-token' }));
      const live = wrapLiveModule('live-app-check', 'firebase/app-check', real.module, site);
      return { ran: real.ran, invoke: () => live.getToken!({ app }) };
    },
  },
  {
    row: 'App Check',
    call: 'onTokenChanged',
    make: (site, app) => {
      const real = standIn(['onTokenChanged'], () => noop);
      const live = wrapLiveModule('live-app-check', 'firebase/app-check', real.module, site);
      return { ran: real.ran, invoke: () => live.onTokenChanged!({ app }, noop) };
    },
  },
  {
    row: 'Auth',
    call: 'onAuthStateChanged',
    make: (site, app) => {
      const real = standIn(['onAuthStateChanged'], () => noop);
      const live = wrapLiveModule('live-auth', 'firebase/auth', real.module, site);
      return { ran: real.ran, invoke: () => live.onAuthStateChanged!({ app }, noop) };
    },
  },
];

/** Whether a call that ran made a record: every call production answers does. */
function expectRecorded(rowCall: RowCall, records: readonly LiveCallRecord[]): void {
  const expectsNone = rowCall.answersLocally === true;
  if (expectsNone) expect(records).toEqual([]);
  else expect(records.length).toBeGreaterThan(0);
}

function siteOf(observer: LiveObserver): LiveModuleSite {
  return { observer, sdkVersion: '12.12.0', client: 'page' };
}

function thrown(invoke: () => unknown): ProjectRefusalData | undefined {
  try {
    invoke();
  } catch (error) {
    return error as ProjectRefusalData;
  }
  return undefined;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a live row on a host for another project', () => {
  for (const rowCall of ROW_CALLS) {
    test(`${rowCall.row} ${rowCall.call} throws PYRIC_LIVE_REFUSED before the real call, and makes no record`, async () => {
      const { records, observer } = hostObserver(HOST);
      const { ran, invoke } = rowCall.make(siteOf(observer), appOn(OTHER));
      const error = thrown(invoke);
      await tick();
      expect(error?.code).toBe(LIVE_REFUSED);
      expect(ran).toEqual([]);
      expect(records).toEqual([]);
    });
  }

  for (const rowCall of ROW_CALLS) {
    test(`${rowCall.row} ${rowCall.call} runs when its app names the host's project, and is recorded when production answers it`, async () => {
      const { records, observer } = hostObserver(HOST);
      const { ran, invoke } = rowCall.make(siteOf(observer), appOn(HOST));
      expect(thrown(invoke)).toBeUndefined();
      await tick();
      expect(ran).toEqual([rowCall.call]);
      expectRecorded(rowCall, records);
      expect(records.every((record) => record.projectId === HOST)).toBe(true);
    });
  }

  for (const rowCall of ROW_CALLS) {
    test(`${rowCall.row} ${rowCall.call} is not refused when its app names no project`, async () => {
      const { observer } = hostObserver(HOST);
      const { ran, invoke } = rowCall.make(siteOf(observer), appOn(undefined));
      expect(thrown(invoke)).toBeUndefined();
      await tick();
      expect(ran).toEqual([rowCall.call]);
    });
  }

  for (const rowCall of ROW_CALLS) {
    test(`${rowCall.row} ${rowCall.call} is not refused by an observer that names no host project`, async () => {
      const { records, observer } = hostObserver(undefined);
      const { ran, invoke } = rowCall.make(siteOf(observer), appOn(OTHER));
      expect(thrown(invoke)).toBeUndefined();
      await tick();
      expect(ran).toEqual([rowCall.call]);
      expect(records.every((record) => record.projectId === OTHER)).toBe(true);
    });
  }

  test('firebase/app calls are never refused: they make no request', () => {
    const { observer } = hostObserver(HOST);
    const real = standIn(['deleteApp'], () => Promise.resolve());
    const live = wrapLiveModule('live-app', 'firebase/app', real.module, siteOf(observer));
    expect(thrown(() => live.deleteApp!(appOn(OTHER)))).toBeUndefined();
    expect(real.ran).toEqual(['deleteApp']);
  });
});

/** Config fields that name the project `b`: the default RTDB hosts, the default buckets and the default auth domains. */
const OTHER_PROJECT_FIELDS: readonly Record<string, string>[] = [
  { databaseURL: `https://${OTHER}-default-rtdb.firebaseio.com` },
  { databaseURL: `https://${OTHER}-default-rtdb.europe-west1.firebasedatabase.app` },
  { databaseURL: `https://${OTHER}-default-rtdb.asia-southeast1.firebasedatabase.app/` },
  { storageBucket: `${OTHER}.appspot.com` },
  { storageBucket: `${OTHER}.firebasestorage.app` },
  { storageBucket: `gs://${OTHER}.firebasestorage.app` },
  { authDomain: `${OTHER}.firebaseapp.com` },
  { authDomain: `${OTHER}.web.app` },
  { authDomain: `${OTHER}.firebaseapp.com:443` },
  { authDomain: `${OTHER}.web.app.` },
  { authDomain: `${OTHER}.firebaseapp.com.:8080` },
  { authDomain: `${HOST}.firebaseapp.com`, storageBucket: `${OTHER}.appspot.com` },
];

/** The same fields naming the host's project `a`, alone and together. */
const HOST_PROJECT_FIELDS: readonly Record<string, string>[] = [
  { databaseURL: `https://${HOST}-default-rtdb.firebaseio.com` },
  { databaseURL: `https://${HOST}-default-rtdb.europe-west1.firebasedatabase.app` },
  { storageBucket: `${HOST}.appspot.com` },
  { storageBucket: `${HOST}.firebasestorage.app` },
  { authDomain: `${HOST}.firebaseapp.com` },
  { authDomain: `${HOST}.web.app` },
  { authDomain: `${HOST}.firebaseapp.com:443` },
  { authDomain: `${HOST}.web.app.` },
  {
    authDomain: `${HOST}.firebaseapp.com`,
    databaseURL: `https://${HOST}-default-rtdb.firebaseio.com`,
    storageBucket: `${HOST}.firebasestorage.app`,
  },
];

/**
 * Fields that encode no project, so the check cannot judge them: a custom
 * auth domain, a bucket that is not a default one, an RTDB instance that is
 * not a default one, the emulator, and values that are not URLs or hosts.
 */
const UNJUDGED_FIELDS: readonly Record<string, string>[] = [
  { authDomain: 'login.example.com' },
  { authDomain: `${OTHER}.example.com` },
  { storageBucket: 'uploads-bucket' },
  { storageBucket: `${OTHER}-uploads` },
  { databaseURL: `https://${OTHER}.firebaseio.com` },
  { databaseURL: `https://${OTHER}-chat.europe-west1.firebasedatabase.app` },
  { databaseURL: `http://127.0.0.1:9000?ns=${OTHER}-default-rtdb` },
  { databaseURL: 'not a url' },
];

const fieldsName = (fields: Record<string, string>) => JSON.stringify(fields);

describe('a live row whose app names no projectId, on a host for project a', () => {
  for (const rowCall of ROW_CALLS) {
    for (const fields of OTHER_PROJECT_FIELDS) {
      test(`${rowCall.row} ${rowCall.call} with ${fieldsName(fields)} throws PYRIC_LIVE_REFUSED before the real call`, async () => {
        const { records, observer } = hostObserver(HOST);
        const { ran, invoke } = rowCall.make(siteOf(observer), appWith(fields));
        const error = thrown(invoke);
        await tick();
        expect(error?.code).toBe(LIVE_REFUSED);
        expect(ran).toEqual([]);
        expect(records).toEqual([]);
      });
    }
  }

  for (const rowCall of ROW_CALLS) {
    for (const fields of HOST_PROJECT_FIELDS) {
      test(`${rowCall.row} ${rowCall.call} with ${fieldsName(fields)} runs, and is recorded when production answers it`, async () => {
        const { records, observer } = hostObserver(HOST);
        const { ran, invoke } = rowCall.make(siteOf(observer), appWith(fields));
        expect(thrown(invoke)).toBeUndefined();
        await tick();
        expect(ran).toEqual([rowCall.call]);
        expectRecorded(rowCall, records);
      });
    }
  }

  for (const rowCall of ROW_CALLS) {
    for (const fields of UNJUDGED_FIELDS) {
      test(`${rowCall.row} ${rowCall.call} with ${fieldsName(fields)} cannot be judged, so it runs`, async () => {
        const { observer } = hostObserver(HOST);
        const { ran, invoke } = rowCall.make(siteOf(observer), appWith(fields));
        expect(thrown(invoke)).toBeUndefined();
        await tick();
        expect(ran).toEqual([rowCall.call]);
      });
    }
  }

  test('the refusal carries the field it judged and both projects as data', () => {
    const { observer } = hostObserver(HOST);
    const { invoke } = ROW_CALLS[0]!.make(siteOf(observer), appWith({ storageBucket: `${OTHER}.appspot.com` }));
    const error = thrown(invoke);
    expect(error?.code).toBe(LIVE_REFUSED);
    expect(error?.field).toBe('storageBucket');
    expect(error?.appProjectId).toBe(OTHER);
    expect(error?.hostProjectId).toBe(HOST);
  });

  test('fields naming another project are not refused by an observer that names no host project', () => {
    const { observer } = hostObserver(undefined);
    const { ran, invoke } = ROW_CALLS[0]!.make(siteOf(observer), appWith({ authDomain: `${OTHER}.firebaseapp.com` }));
    expect(thrown(invoke)).toBeUndefined();
    expect(ran).toEqual([ROW_CALLS[0]!.call]);
  });
});

describe('a live row whose app names the host project as projectId, on a host for project a', () => {
  for (const rowCall of ROW_CALLS) {
    for (const fields of OTHER_PROJECT_FIELDS) {
      test(`${rowCall.row} ${rowCall.call} with ${fieldsName(fields)} beside it throws PYRIC_LIVE_REFUSED before the real call`, async () => {
        const { records, observer } = hostObserver(HOST);
        const { ran, invoke } = rowCall.make(siteOf(observer), hostAppWith(fields));
        const error = thrown(invoke);
        await tick();
        expect(error?.code).toBe(LIVE_REFUSED);
        expect(ran).toEqual([]);
        expect(records).toEqual([]);
      });
    }
  }

  for (const rowCall of ROW_CALLS) {
    for (const fields of [...HOST_PROJECT_FIELDS, ...UNJUDGED_FIELDS]) {
      test(`${rowCall.row} ${rowCall.call} with ${fieldsName(fields)} beside it runs`, async () => {
        const { observer } = hostObserver(HOST);
        const { ran, invoke } = rowCall.make(siteOf(observer), hostAppWith(fields));
        expect(thrown(invoke)).toBeUndefined();
        await tick();
        expect(ran).toEqual([rowCall.call]);
      });
    }
  }

  const JUDGED_FIELDS: readonly (readonly [string, string])[] = [
    ['databaseURL', `https://${OTHER}-default-rtdb.firebaseio.com`],
    ['storageBucket', `${OTHER}.firebasestorage.app`],
    ['authDomain', `${OTHER}.web.app`],
  ];

  for (const [field, value] of JUDGED_FIELDS) {
    test(`the refusal names ${field} as the field it judged`, () => {
      const { observer } = hostObserver(HOST);
      const { invoke } = ROW_CALLS[0]!.make(siteOf(observer), hostAppWith({ [field]: value }));
      const error = thrown(invoke);
      expect(error?.field).toBe(field);
      expect(error?.appProjectId).toBe(OTHER);
      expect(error?.hostProjectId).toBe(HOST);
    });
  }

  test('a projectId of another project is the field judged, ahead of matching fields', () => {
    const { observer } = hostObserver(HOST);
    const app = { options: { apiKey: 'key', projectId: OTHER, authDomain: `${HOST}.firebaseapp.com` } };
    const error = thrown(ROW_CALLS[0]!.make(siteOf(observer), app).invoke);
    expect(error?.code).toBe(LIVE_REFUSED);
    expect(error?.field).toBe('projectId');
    expect(error?.appProjectId).toBe(OTHER);
  });
});

/** A call that reaches an instance or bucket of its own, beside the app's config. */
interface TargetCall {
  readonly row: string;
  readonly field: 'instance' | 'bucket';
  readonly make: (site: LiveModuleSite, app: unknown, target: string) => { readonly ran: string[]; readonly invoke: () => unknown };
}

const TARGET_CALLS: readonly TargetCall[] = [
  {
    row: 'Realtime Database get',
    field: 'instance',
    make: (site, app, target) => databaseCall(site, app, 'get', () => Promise.resolve('real'), (live, ref) => live.get!(ref), target),
  },
  {
    row: 'Realtime Database onValue',
    field: 'instance',
    make: (site, app, target) => databaseCall(site, app, 'onValue', () => noop, (live, ref) => live.onValue!(ref, noop), target),
  },
  { row: 'Cloud Storage getDownloadURL', field: 'bucket', make: storageCall },
];

/** Instances and buckets of project `b`, in the default forms that encode it, by the field that reaches them. */
const OTHER_TARGETS: Readonly<Record<TargetCall['field'], readonly string[]>> = {
  instance: [`${OTHER}-default-rtdb`],
  bucket: [`${OTHER}.appspot.com`, `${OTHER}.firebasestorage.app`],
};

/**
 * Instances and buckets that encode no project: a named instance, a legacy
 * default instance (which looks like one), the instance or bucket the SDK
 * reference did not name, and a bucket with a name of its own.
 */
const UNJUDGED_TARGETS: Readonly<Record<TargetCall['field'], readonly string[]>> = {
  instance: [OTHER, `${OTHER}-chat`, 'instance-not-read-from-the-sdk-reference'],
  bucket: ['uploads-bucket', `${OTHER}-uploads`, 'bucket-not-read-from-the-sdk-reference'],
};

const HOST_TARGETS: Readonly<Record<TargetCall['field'], string>> = { instance: HOST_INSTANCE, bucket: HOST_BUCKET };

const TARGET_APPS: readonly (readonly [string, ReturnType<typeof appOn>])[] = [
  ['the host projectId', appOn(HOST)],
  ['no projectId', appOn(undefined)],
];

describe("a live call that reaches another project's instance or bucket, on a host for project a", () => {
  for (const targetCall of TARGET_CALLS) {
    for (const target of OTHER_TARGETS[targetCall.field]) {
      for (const [appName, app] of TARGET_APPS) {
        test(`${targetCall.row} on ${target}, from an app with ${appName}, throws PYRIC_LIVE_REFUSED naming ${targetCall.field}`, async () => {
          const { records, observer } = hostObserver(HOST);
          const { ran, invoke } = targetCall.make(siteOf(observer), app, target);
          const error = thrown(invoke);
          await tick();
          expect(error?.code).toBe(LIVE_REFUSED);
          expect(error?.field).toBe(targetCall.field);
          expect(error?.appProjectId).toBe(OTHER);
          expect(error?.hostProjectId).toBe(HOST);
          expect(ran).toEqual([]);
          expect(records).toEqual([]);
        });
      }
    }

    for (const target of UNJUDGED_TARGETS[targetCall.field]) {
      test(`${targetCall.row} on ${target} cannot be judged, so it runs and is recorded`, async () => {
        const { records, observer } = hostObserver(HOST);
        const { ran, invoke } = targetCall.make(siteOf(observer), appOn(HOST), target);
        expect(thrown(invoke)).toBeUndefined();
        await tick();
        expect(ran.length).toBe(1);
        expect(records.length).toBeGreaterThan(0);
      });
    }

    test(`${targetCall.row} on the host's ${targetCall.field} runs`, async () => {
      const { observer } = hostObserver(HOST);
      const { ran, invoke } = targetCall.make(siteOf(observer), appOn(HOST), HOST_TARGETS[targetCall.field]);
      expect(thrown(invoke)).toBeUndefined();
      await tick();
      expect(ran.length).toBe(1);
    });

    test(`${targetCall.row} on another project's ${targetCall.field} is not refused by an observer that names no host project`, async () => {
      const { observer } = hostObserver(undefined);
      const target = OTHER_TARGETS[targetCall.field][0]!;
      const { ran, invoke } = targetCall.make(siteOf(observer), appOn(HOST), target);
      expect(thrown(invoke)).toBeUndefined();
      await tick();
      expect(ran.length).toBe(1);
    });
  }

  test('a config field naming another project is the field judged, ahead of the instance', () => {
    const { observer } = hostObserver(HOST);
    const app = hostAppWith({ storageBucket: `${OTHER}.appspot.com` });
    const error = thrown(TARGET_CALLS[0]!.make(siteOf(observer), app, `${OTHER}-default-rtdb`).invoke);
    expect(error?.field).toBe('storageBucket');
  });
});

/** `getDatabase(app, url)` through a stand-in Realtime Database row, on `client`: whether the real factory ran, and the call. */
function getDatabaseCall(observer: LiveObserver, client: LiveClient, app: unknown, url: unknown): { readonly ran: string[]; readonly invoke: () => unknown } {
  const real = standIn(['getDatabase'], () => ({ app, _repoInternal: { repoInfo_: { namespace: HOST_INSTANCE } } }));
  const live = wrapLiveModule('live-database', 'firebase/database', real.module, { observer, sdkVersion: '12.12.0', client });
  return { ran: real.ran, invoke: () => (url === undefined ? live.getDatabase!(app) : live.getDatabase!(app, url)) };
}

/** URLs whose namespace, as the SDK parses it, is project `b`'s default instance. */
const OTHER_INSTANCE_URLS: readonly string[] = [
  `https://${OTHER}-default-rtdb.firebaseio.com`,
  `https://${OTHER}-default-rtdb.firebaseio.com/`,
  `https://${OTHER.toUpperCase()}-Default-RTDB.firebaseio.com`,
  `https://${OTHER}-default-rtdb.europe-west1.firebasedatabase.app`,
  `${OTHER}-default-rtdb.asia-southeast1.firebasedatabase.app`,
  `http://127.0.0.1:9000?ns=${OTHER}-default-rtdb`,
  `http://localhost:9000/?ns=${OTHER}-default-rtdb`,
  `https://${HOST}-default-rtdb.firebaseio.com?ns=${OTHER}-default-rtdb`,
  `https://${HOST}-default-rtdb.firebaseio.com?ns=${HOST}-default-rtdb&ns=${OTHER}-default-rtdb`,
];

/** URLs whose namespace is the host's default instance. */
const HOST_INSTANCE_URLS: readonly string[] = [
  `https://${HOST}-default-rtdb.firebaseio.com`,
  `https://${HOST}-default-rtdb.europe-west1.firebasedatabase.app/`,
  `http://127.0.0.1:9000?ns=${HOST}-default-rtdb`,
];

/**
 * URLs whose namespace encodes no project, so they run: a named instance, a
 * legacy default instance, a host with no namespace, a query that cannot
 * be decoded, and values that are no URL.
 */
const UNJUDGED_INSTANCE_URLS: readonly unknown[] = [
  `https://${OTHER}.firebaseio.com`,
  `https://${OTHER}-chat.europe-west1.firebasedatabase.app`,
  'http://localhost:9000',
  `http://127.0.0.1:9000?ns=${OTHER}`,
  'https://firebaseio.com',
  `http://127.0.0.1:9000?ns=%E0%A4%A`,
  'not a url',
  '',
  undefined,
  42,
];

const CLIENTS: readonly LiveClient[] = ['page', 'node'];

describe("getDatabase(app, url) on another project's default instance, on a host for project a", () => {
  for (const client of CLIENTS) {
    for (const url of OTHER_INSTANCE_URLS) {
      test(`from ${client}, getDatabase(app, ${JSON.stringify(url)}) throws PYRIC_LIVE_REFUSED before the real factory runs`, () => {
        const { records, observer } = hostObserver(HOST);
        const { ran, invoke } = getDatabaseCall(observer, client, appOn(HOST), url);
        const error = thrown(invoke);
        expect({ code: error?.code, field: error?.field, appProjectId: error?.appProjectId, hostProjectId: error?.hostProjectId }).toEqual({
          code: LIVE_REFUSED,
          field: 'instance',
          appProjectId: OTHER,
          hostProjectId: HOST,
        });
        expect(ran).toEqual([]);
        expect(records).toEqual([]);
      });
    }

    for (const url of [...HOST_INSTANCE_URLS, ...UNJUDGED_INSTANCE_URLS]) {
      test(`from ${client}, getDatabase(app, ${JSON.stringify(url)}) runs the real factory`, () => {
        const { observer } = hostObserver(HOST);
        const { ran, invoke } = getDatabaseCall(observer, client, appOn(HOST), url);
        expect(thrown(invoke)).toBeUndefined();
        expect(ran).toEqual(['getDatabase']);
      });
    }
  }

  /** Apps whose config names project `b`, and the field the refusal judges. */
  const OTHER_CONFIG_APPS: readonly (readonly [unknown, string])[] = [
    [appOn(OTHER), 'projectId'],
    [appWith({ databaseURL: `https://${OTHER}-default-rtdb.firebaseio.com` }), 'databaseURL'],
    [hostAppWith({ databaseURL: `https://${OTHER}-default-rtdb.europe-west1.firebasedatabase.app` }), 'databaseURL'],
    [hostAppWith({ storageBucket: `${OTHER}.appspot.com` }), 'storageBucket'],
    [hostAppWith({ authDomain: `${OTHER}.firebaseapp.com` }), 'authDomain'],
  ];

  for (const client of CLIENTS) {
    for (const [app, field] of OTHER_CONFIG_APPS) {
      for (const url of [undefined, HOST_INSTANCE_URLS[0]]) {
        test(`from ${client}, getDatabase(${JSON.stringify(app)}${url === undefined ? '' : `, ${url}`}) throws PYRIC_LIVE_REFUSED judging ${field}`, () => {
          const { records, observer } = hostObserver(HOST);
          const { ran, invoke } = getDatabaseCall(observer, client, app, url);
          const error = thrown(invoke);
          expect({ code: error?.code, field: error?.field, appProjectId: error?.appProjectId, hostProjectId: error?.hostProjectId }).toEqual({
            code: LIVE_REFUSED,
            field,
            appProjectId: OTHER,
            hostProjectId: HOST,
          });
          expect(ran).toEqual([]);
          expect(records).toEqual([]);
        });
      }
    }

    test(`from ${client}, getDatabase(app) runs when the app names the host's project or none`, () => {
      for (const app of [appOn(HOST), appOn(undefined), hostAppWith({ databaseURL: `https://${HOST}-default-rtdb.firebaseio.com` })]) {
        const { observer } = hostObserver(HOST);
        const { ran, invoke } = getDatabaseCall(observer, client, app, undefined);
        expect(thrown(invoke)).toBeUndefined();
        expect(ran).toEqual(['getDatabase']);
      }
    });
  }

  test("a config field naming another project is the field judged, ahead of the URL's instance", () => {
    const { observer } = hostObserver(HOST);
    const app = hostAppWith({ storageBucket: `${OTHER}.appspot.com` });
    const error = thrown(getDatabaseCall(observer, 'page', app, OTHER_INSTANCE_URLS[0]).invoke);
    expect(error?.field).toBe('storageBucket');
  });

  /** `getDatabase()` with no app, on a site whose `getApps` lists `apps`; the stand-in factory returns a Database of `made`. */
  function noAppCall(client: LiveClient, apps: readonly unknown[], made: unknown, url?: string): { readonly ran: string[]; readonly invoke: () => unknown } {
    const { observer } = hostObserver(HOST);
    const real = standIn(['getDatabase'], () => ({ app: made, _repoInternal: { repoInfo_: { namespace: HOST_INSTANCE } } }));
    const live = wrapLiveModule('live-database', 'firebase/database', real.module, { observer, sdkVersion: '12.12.0', client, apps: () => apps });
    return { ran: real.ran, invoke: () => (url === undefined ? live.getDatabase!() : live.getDatabase!(undefined, url)) };
  }

  const named = (name: string, app: { options: Record<string, string> }) => ({ name, ...app });
  const otherDefault = named('[DEFAULT]', appOn(OTHER));
  const hostDefault = named('[DEFAULT]', appOn(HOST));

  for (const client of CLIENTS) {
    test(`from ${client}, getDatabase() on a default app whose config names another project throws before the real factory runs`, () => {
      for (const app of [otherDefault, named('[DEFAULT]', hostAppWith({ databaseURL: `https://${OTHER}-default-rtdb.firebaseio.com` }))]) {
        const { ran, invoke } = noAppCall(client, [named('second', appOn(HOST)), app], app);
        const error = thrown(invoke);
        expect({ code: error?.code, appProjectId: error?.appProjectId, hostProjectId: error?.hostProjectId }).toEqual({
          code: LIVE_REFUSED,
          appProjectId: OTHER,
          hostProjectId: HOST,
        });
        expect(ran).toEqual([]);
      }
    });

    test(`from ${client}, getDatabase() names the default app's config field: projectId, then databaseURL`, () => {
      const byDatabaseURL = named('[DEFAULT]', hostAppWith({ databaseURL: `https://${OTHER}-default-rtdb.firebaseio.com` }));
      expect(thrown(noAppCall(client, [otherDefault], otherDefault).invoke)?.field).toBe('projectId');
      expect(thrown(noAppCall(client, [byDatabaseURL], byDatabaseURL).invoke)?.field).toBe('databaseURL');
    });

    test(`from ${client}, getDatabase() on a host default app runs, and getDatabase(undefined, url) still judges the URL`, () => {
      const runs = noAppCall(client, [named('other', appOn(OTHER)), hostDefault], hostDefault);
      expect(thrown(runs.invoke)).toBeUndefined();
      expect(runs.ran).toEqual(['getDatabase']);
      const refused = noAppCall(client, [hostDefault], hostDefault, `https://${OTHER}-default-rtdb.firebaseio.com`);
      expect(thrown(refused.invoke)?.field).toBe('instance');
      expect(refused.ran).toEqual([]);
    });

    test(`from ${client}, getDatabase() with no default app yet judges the app the real factory made before returning it`, () => {
      const made = noAppCall(client, [named('other', appOn(OTHER))], otherDefault);
      const error = thrown(made.invoke);
      expect({ code: error?.code, field: error?.field, appProjectId: error?.appProjectId }).toEqual({ code: LIVE_REFUSED, field: 'projectId', appProjectId: OTHER });
      const host = noAppCall(client, [], hostDefault);
      expect(thrown(host.invoke)).toBeUndefined();
      expect(host.ran).toEqual(['getDatabase']);
    });
  }

  test("getDatabase() with no default app lets the real factory throw its own error", () => {
    const { observer } = hostObserver(HOST);
    const noApp = Object.assign(new Error('no-app'), { code: 'app/no-app' });
    const real = { getDatabase: () => { throw noApp; } };
    const live = wrapLiveModule('live-database', 'firebase/database', real, { observer, sdkVersion: '12.12.0', client: 'page', apps: () => [] });
    expect(thrown(() => live.getDatabase())).toBe(noApp);
  });

  test("getDatabase(app) of another project's app runs under an observer that names no host project", () => {
    const { observer } = hostObserver(undefined);
    const { ran, invoke } = getDatabaseCall(observer, 'node', appOn(OTHER), undefined);
    expect(thrown(invoke)).toBeUndefined();
    expect(ran).toEqual(['getDatabase']);
  });

  test("getDatabase(app, url) on another project's instance runs under an observer that names no host project", () => {
    const { observer } = hostObserver(undefined);
    const { ran, invoke } = getDatabaseCall(observer, 'page', appOn(HOST), OTHER_INSTANCE_URLS[0]);
    expect(thrown(invoke)).toBeUndefined();
    expect(ran).toEqual(['getDatabase']);
  });

  test('getDatabase(app, url) on the host instance still notes the database, so its reads name the app', async () => {
    const { records, observer } = hostObserver(HOST);
    const app = appOn(HOST);
    const repo = { repoInfo_: { namespace: HOST_INSTANCE } };
    const real = standIn(['getDatabase', 'get'], (name) => (name === 'getDatabase' ? { app, _repoInternal: repo } : Promise.resolve('real')));
    const live = wrapLiveModule('live-database', 'firebase/database', real.module, siteOf(observer));
    live.getDatabase!(app, HOST_INSTANCE_URLS[0]);
    await live.get!({ _repo: repo, _path: { toString: () => '/items' } });
    expect(records.map((record) => [record.name, record.projectId, record.instance])).toEqual([['get', HOST, HOST_INSTANCE]]);
  });
});

const AUTH_ACTION_EXPORTS = [
  'applyActionCode',
  'checkActionCode',
  'confirmPasswordReset',
  'verifyPasswordResetCode',
  'fetchSignInMethodsForEmail',
] as const;

const USER_FIRST_AUTH_EXPORTS = [
  'sendEmailVerification',
  'verifyBeforeUpdateEmail',
  'reload',
  'updateProfile',
  'updateEmail',
  'updatePassword',
  'deleteUser',
  'linkWithCredential',
  'linkWithPopup',
  'linkWithRedirect',
  'unlink',
  'reauthenticateWithCredential',
  'reauthenticateWithPopup',
  'reauthenticateWithRedirect',
  'getIdToken',
  'getIdTokenResult',
] as const;

describe('auth action-code and User-first exports', () => {
  for (const name of AUTH_ACTION_EXPORTS) {
    test(`${name}(auth, ...) throws PYRIC_LIVE_REFUSED on another project's Auth before running`, () => {
      const { records, observer } = hostObserver(HOST);
      const real = standIn([name]);
      const live = wrapLiveModule('live-auth', 'firebase/auth', real.module, siteOf(observer));
      const error = thrown(() => live[name]!({ app: appOn(OTHER) }, 'code-1'));
      expect({ code: error?.code, field: error?.field, appProjectId: error?.appProjectId, hostProjectId: error?.hostProjectId }).toEqual({
        code: LIVE_REFUSED,
        field: 'projectId',
        appProjectId: OTHER,
        hostProjectId: HOST,
      });
      expect(real.ran).toEqual([]);
      expect(records).toEqual([]);

      expect(thrown(() => live[name]!({ app: appOn(HOST) }, 'code-1'))).toBeUndefined();
      expect(real.ran).toEqual([name]);
    });
  }

  for (const name of USER_FIRST_AUTH_EXPORTS) {
    test(`${name}(user, ...) reads user.auth.app.options and refuses another project's User before running`, () => {
      const { records, observer } = hostObserver(HOST);
      const real = standIn([name]);
      const live = wrapLiveModule('live-auth', 'firebase/auth', real.module, siteOf(observer));
      const otherUser = { uid: 'u-other', auth: { app: appOn(OTHER) } };
      const hostUser = { uid: 'u-host', auth: { app: appOn(HOST) } };
      const error = thrown(() => live[name]!(otherUser, 'arg-1'));
      expect({ code: error?.code, field: error?.field, appProjectId: error?.appProjectId, hostProjectId: error?.hostProjectId }).toEqual({
        code: LIVE_REFUSED,
        field: 'projectId',
        appProjectId: OTHER,
        hostProjectId: HOST,
      });
      expect(real.ran).toEqual([]);
      expect(records).toEqual([]);

      expect(thrown(() => live[name]!(hostUser, 'arg-1'))).toBeUndefined();
      expect(real.ran).toEqual([name]);
    });
  }
});

describe('Cloud Storage uppercase and malformed bucket refusal', () => {
  test('lowercases StorageReference.bucket before judging cross-project default buckets', () => {
    const { records, observer } = hostObserver(HOST);
    const { ran, invoke } = storageCall(siteOf(observer), appOn(HOST), `${OTHER.toUpperCase()}.Appspot.com`);
    const error = thrown(invoke);
    expect({ code: error?.code, field: error?.field, appProjectId: error?.appProjectId, hostProjectId: error?.hostProjectId }).toEqual({
      code: LIVE_REFUSED,
      field: 'bucket',
      appProjectId: OTHER,
      hostProjectId: HOST,
    });
    expect(ran).toEqual([]);
    expect(records).toEqual([]);
  });

  test('fails closed with PYRIC_LIVE_REFUSED when StorageReference.bucket is a non-empty malformed bucket string', () => {
    const { records, observer } = hostObserver(HOST);
    const { ran, invoke } = storageCall(siteOf(observer), appOn(HOST), `gs://${OTHER}.appspot.com/extra`);
    const error = thrown(invoke);
    expect(error?.code).toBe(LIVE_REFUSED);
    expect(ran).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('the project refusal', () => {
  test('carries the live refusal code and names both projects and the client', () => {
    const error = refusal.liveProjectRefusal('getDoc', { field: 'projectId', appProjectId: OTHER, hostProjectId: HOST }, 'node');
    expect(error.code).toBe(LIVE_REFUSED);
    expect(error.field).toBe('projectId');
    expect(error.message).toContain("'b'");
    expect(error.message).toContain("'a'");
    expect(error.message).toContain('a Node process');
  });
});
