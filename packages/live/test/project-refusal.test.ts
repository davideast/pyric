/**
 * The live wrapper's project check. An observer that names the host's
 * project (`hostProjectId`) refuses every observed call and listener whose
 * app names another project: the wrapper throws `PYRIC_LIVE_REFUSED` before
 * the real function runs, and the observer gets no record. A call whose
 * project can't be read, and a call to the host's project, run as the app
 * called them. An app with no projectId names its project through the
 * default forms of its databaseURL, storageBucket and authDomain; a custom
 * domain or bucket encodes none and is not judged. Each row is a stand-in
 * module, so a spy tells whether the real function ran.
 */
import { describe, expect, test } from 'bun:test';
import { wrapLiveModule, type LiveModuleSite } from '../src/modules.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';
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

/**
 * A call through a stand-in Realtime Database row, on a reference to the
 * database the row noted from `getDatabase(app)`, as the SDK's repo is.
 */
function databaseCall(
  site: LiveModuleSite,
  app: unknown,
  name: string,
  returned: () => unknown,
  call: (live: Record<string, Callback>, ref: unknown) => unknown,
): { readonly ran: string[]; readonly invoke: () => unknown } {
  const repo = { repoInfo_: { namespace: 'demo-default-rtdb' } };
  const real = standIn([name], returned);
  const module: Record<string, Callback> = { ...real.module, getDatabase: () => ({ app, _repoInternal: repo }) };
  const live = wrapLiveModule('live-database', 'firebase/database', module, site);
  live.getDatabase!(app);
  const ref = { _repo: repo, _path: { toString: () => '/items' } };
  return { ran: real.ran, invoke: () => call(live, ref) };
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
    make: (site, app) => {
      const real = standIn(['getDownloadURL']);
      const live = wrapLiveModule('live-storage', 'firebase/storage', real.module, site);
      const ref = { storage: { app }, bucket: 'demo.firebasestorage.app', fullPath: 'images/a.png' };
      return { ran: real.ran, invoke: () => live.getDownloadURL!(ref) };
    },
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
