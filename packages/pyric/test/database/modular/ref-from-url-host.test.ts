/**
 * `refFromURL` host check and the query and `child()` error texts, against the
 * production SDK (`firebase/database` 12.13.0, run offline in the 2026-10-27
 * SDK hunt: RT-12 from `SDK-RT-9-14.mjs`, RT-14 from `SDK-RT-14.mjs`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps } from '../../../src/app/index.js';
import { createAppForSandbox } from '../../../src/app/internal.js';
import {
  child,
  endAt,
  endBefore,
  equalTo,
  getDatabase,
  orderByKey,
  orderByValue,
  query,
  ref,
  refFromURL,
  startAfter,
  startAt,
} from '../../../src/database/index.js';
import { load } from './oracle-conformance.support.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

let appCount = 0;
const appName = (): string => `ref-from-url-host-${++appCount}`;

function thrownMessage(task: () => unknown): string {
  try {
    task();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the call to throw');
}

describe('refFromURL checks the URL host against the database (RT-12)', () => {
  it('throws the SDK error for another instance on firebaseio.com', () => {
    const app = createAppForSandbox(initializeSandbox(), { projectId: 'demo-sdkhunt' }, appName());
    const db = getDatabase(app);
    expect(thrownMessage(() => refFromURL(db, 'https://other-db.firebaseio.com/a'))).toBe(
      'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found other-db.firebaseio.com but expected demo-sdkhunt-default-rtdb.firebaseio.com) ',
    );
  });

  it('matches the captured production error for the reference-shape oracle', () => {
    const obs = load('rtdb-modular-reference-shape-url.json');
    const expected = (obs.mismatchedHost as { message: string }).message;
    const app = createAppForSandbox(
      initializeSandbox(),
      { projectId: 'digame-mas', databaseURL: 'https://digame-mas-default-rtdb.firebaseio.com' },
      appName(),
    );
    const db = getDatabase(app);
    expect(thrownMessage(() => refFromURL(db, 'https://other-digame-mas-default-rtdb.firebaseio.com/a'))).toBe(expected);
  });

  it('checks a named instance opened from a sandbox by name', () => {
    const db = getDatabase(initializeSandbox(), 'second-db');
    expect(() => refFromURL(db, 'https://other-db.firebaseio.com/a')).toThrow(
      'found other-db.firebaseio.com but expected second-db.firebaseio.com',
    );
    expect(refFromURL(db, 'https://second-db.firebaseio.com/a/b')._path).toBe('/a/b');
  });

  it('accepts the database own host in any case', () => {
    const app = createAppForSandbox(initializeSandbox(), { projectId: 'demo-sdkhunt' }, appName());
    const db = getDatabase(app);
    expect(refFromURL(db, 'https://demo-sdkhunt-default-rtdb.firebaseio.com/a/b')._path).toBe('/a/b');
    expect(refFromURL(db, 'https://DEMO-SDKHUNT-default-rtdb.firebaseio.com/a')._path).toBe('/a');
    expect(() => refFromURL(db, 'https://other.europe-west1.firebasedatabase.app/c')).toThrow(
      'Host name does not match the current database',
    );
  });

  it('skips the check when the database host is custom, as the SDK does', () => {
    // RepoInfo.isCustomHost(): every domain except firebaseio.com and firebaseio-demo.com.
    const db = getDatabase(initializeSandbox(), 'https://regional.europe-west1.firebasedatabase.app');
    expect(refFromURL(db, 'https://other-db.firebaseio.com/c')._path).toBe('/c');
  });

  it('skips the check for a sandbox database opened without a URL, which has no host', () => {
    const db = getDatabase(initializeSandbox());
    expect(refFromURL(db, 'https://other-db.firebaseio.com/c')._path).toBe('/c');
  });

  it('throws the SDK parse error for a value that is not a database URL', () => {
    const obs = load('rtdb-modular-reference-shape-url.json');
    const expected = (obs.malformedUrl as { message: string }).message;
    const db = getDatabase(initializeSandbox());
    expect(thrownMessage(() => refFromURL(db, 'not-an-absolute-url'))).toBe(expected);
  });
});

describe('query and child() errors use the SDK text (RT-14)', () => {
  const root = () => ref(getDatabase(initializeSandbox()), 'q');

  it('a second orderBy names the call that conflicts', () => {
    expect(thrownMessage(() => query(root(), orderByKey(), orderByValue()))).toBe(
      "orderByValue: You can't combine multiple orderBy calls.",
    );
  });

  it('a second start or end point uses each call text', () => {
    expect(thrownMessage(() => query(root(), startAt(1), startAt(2)))).toBe(
      'startAt: Starting point was already set (by another call to startAt, startBefore or equalTo).',
    );
    expect(thrownMessage(() => query(root(), startAt(1), startAfter(2)))).toBe(
      'startAfter: Starting point was already set (by another call to startAt, startAfter, or equalTo).',
    );
    expect(thrownMessage(() => query(root(), orderByValue(), endAt(1), endBefore(2)))).toBe(
      'endBefore: Starting point was already set (by another call to endAt, endBefore or equalTo).',
    );
    expect(thrownMessage(() => query(root(), orderByValue(), endAt(1), endAt(2)))).toBe(
      'endAt: Starting point was already set (by another call to endAt, endBefore or equalTo).',
    );
    expect(thrownMessage(() => query(root(), orderByValue(), startAt(1), equalTo(1)))).toBe(
      'equalTo: Starting point was already set (by another call to startAt/startAfter or equalTo).',
    );
    expect(thrownMessage(() => query(root(), orderByValue(), endAt(1), equalTo(1)))).toBe(
      'equalTo: Ending point was already set (by another call to endAt/endBefore or equalTo).',
    );
  });

  it('an invalid endpoint value names the query path', () => {
    expect(thrownMessage(() => query(root(), orderByValue(), startAt(Number.NaN)))).toBe(
      "startAt failed: value argument contains NaN in property 'q'",
    );
    const deep = ref(getDatabase(initializeSandbox()), 'a/b');
    expect(thrownMessage(() => query(deep, orderByValue(), endBefore(Number.POSITIVE_INFINITY)))).toBe(
      "endBefore failed: value argument contains Infinity in property 'a.b'",
    );
  });

  it('child() with a path that is not a string throws the SDK path error', () => {
    expect(thrownMessage(() => child(root(), 5 as never))).toBe(
      'child failed: path argument was an invalid path = "5". Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"',
    );
  });
});
