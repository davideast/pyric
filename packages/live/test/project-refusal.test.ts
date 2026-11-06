/**
 * The live wrapper's project check. An observer that names the host's
 * project (`hostProjectId`) refuses every observed call and listener whose
 * app names another project: the wrapper throws `PYRIC_LIVE_REFUSED` before
 * the real function runs, and the observer gets no record. A call whose
 * project can't be read, and a call to the host's project, run as the app
 * called them. Each row is a stand-in module, so a spy tells whether the
 * real function ran.
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

/** One call through a live row: the stand-in it wraps, and how the app makes the call on an app. */
interface RowCall {
  readonly row: string;
  readonly call: string;
  readonly make: (site: LiveModuleSite, app: unknown) => { readonly ran: string[]; readonly invoke: () => unknown };
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
    row: 'Auth',
    call: 'onAuthStateChanged',
    make: (site, app) => {
      const real = standIn(['onAuthStateChanged'], () => noop);
      const live = wrapLiveModule('live-auth', 'firebase/auth', real.module, site);
      return { ran: real.ran, invoke: () => live.onAuthStateChanged!({ app }, noop) };
    },
  },
];

function siteOf(observer: LiveObserver): LiveModuleSite {
  return { observer, sdkVersion: '12.12.0', client: 'page' };
}

function thrown(invoke: () => unknown): (Error & { code?: string }) | undefined {
  try {
    invoke();
  } catch (error) {
    return error as Error & { code?: string };
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
    test(`${rowCall.row} ${rowCall.call} runs and is recorded when its app names the host's project`, async () => {
      const { records, observer } = hostObserver(HOST);
      const { ran, invoke } = rowCall.make(siteOf(observer), appOn(HOST));
      expect(thrown(invoke)).toBeUndefined();
      await tick();
      expect(ran).toEqual([rowCall.call]);
      expect(records.length).toBeGreaterThan(0);
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

describe('the project refusal', () => {
  test('carries the live refusal code and names both projects and the client', () => {
    const error = refusal.liveProjectRefusal('getDoc', { appProjectId: OTHER, hostProjectId: HOST }, 'node') as Error & { code?: string };
    expect(error.code).toBe(LIVE_REFUSED);
    expect(error.message).toContain("'b'");
    expect(error.message).toContain("'a'");
    expect(error.message).toContain('a Node process');
  });
});
