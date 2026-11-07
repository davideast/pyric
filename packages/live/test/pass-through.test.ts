/**
 * `pyricLive({ passThrough })`: which imports the option takes, the start-time
 * error for each it does not, and what a refused import tells the app and the
 * dev server about the option. The pass-through itself, a listed import
 * loading the installed SDK on a page, runs through Vite and Chromium in
 * `test/apps/live-pass-through`.
 *
 * Live mode serves firebase-admin itself (D2 in the #2304 plan), so the
 * option refuses it, the register's Admin start check pins its major and
 * the Node floor, and the Admin rows observe for the host's project.
 */
import { describe, expect, test } from 'bun:test';
import { INSTALLED_SDK_SPECIFIERS, SDK_MODULES, livePassThroughLine, pyricWithSuppliedRows } from '@pyric/cli/vite/internal/supplied-rows';
import {
  ADMIN_PASS_THROUGH,
  ADMIN_ROWS_NODE_MAJOR,
  LIVE_REFUSED,
  adminRowsNodeProblem,
  PASS_THROUGH_CANDIDATES,
  liveRefusal,
  passThroughOption,
  refusedImportsLine,
  withPassThroughHint,
} from '../src/refusal.js';
import { adminPassThroughLine, passThroughLines } from '../src/start-line.js';
import { pyricLive } from '../src/vite.js';
import { SUPPORTED_ADMIN_MAJOR, adminStartRefusal, installedAdminVersion } from '../src/start-checks.js';
import { observeAdminRow, serveHostProject } from '../src/node-modules.js';
import type { LiveCallRecord } from '../src/observe.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = '@pyric/live/vite';

function startError(value: unknown): string {
  try {
    passThroughOption(ENTRY, value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`passThrough ${JSON.stringify(value)} was accepted`);
}

describe('the passThrough option', () => {
  test('takes every served Firebase import live mode has no row for, except Firestore Lite, and nothing else', () => {
    const passable = [
      'firebase/analytics', 'firebase/functions', 'firebase/performance', 'firebase/remote-config',
    ];
    const unserved: string[] = SDK_MODULES.filter((specifier) => !INSTALLED_SDK_SPECIFIERS.has(specifier));
    expect([...unserved].sort()).toEqual([...passable, 'firebase/firestore/lite'].sort());
    expect([...PASS_THROUGH_CANDIDATES].sort()).toEqual(passable);
    expect(passThroughOption(ENTRY, passable)).toEqual(passable);
    expect(() => pyricWithSuppliedRows({}, { refusal: liveRefusal, passThrough: passable })).not.toThrow();
  });

  test('refuses firebase/firestore/lite: its Firestore calls would go unobserved and uncounted', () => {
    expect(startError(['firebase/firestore/lite'])).toBe(
      `${ENTRY}: passThrough lists firebase/firestore/lite, which cannot pass through: live mode serves this service as firebase/firestore, ` +
        'and its calls would reach it unobserved and uncounted. Import firebase/firestore instead.',
    );
    expect(() => pyricWithSuppliedRows({}, { refusal: liveRefusal, passThrough: ['firebase/firestore/lite'] }))
      .toThrow('pyric: firebase/firestore/lite cannot pass through');
  });

  test('is empty when absent, and lists each import once', () => {
    expect(passThroughOption(ENTRY, undefined)).toEqual([]);
    expect(passThroughOption(ENTRY, ['firebase/functions', 'firebase/remote-config', 'firebase/functions'])).toEqual(['firebase/functions', 'firebase/remote-config']);
  });

  test('refuses an import live mode already serves, firebase/database, firebase/ai, firebase/storage and both Messaging entries among them', () => {
    for (const named of ['firebase/database', 'firebase/ai', 'firebase/storage', 'firebase/messaging', 'firebase/messaging/sw']) {
      expect(startError([named])).toBe(`${ENTRY}: passThrough lists ${named}, which live mode already serves and observes; remove it.`);
    }
    for (const served of INSTALLED_SDK_SPECIFIERS) {
      expect(startError([served])).toBe(`${ENTRY}: passThrough lists ${served}, which live mode already serves and observes; remove it.`);
    }
  });

  test('refuses firebase-admin and its subpaths: live mode serves and observes the Admin SDK in a Node process', () => {
    expect(ADMIN_PASS_THROUGH).toBe('firebase-admin');
    expect(startError(['firebase/functions', 'firebase-admin'])).toBe(
      `${ENTRY}: passThrough lists firebase-admin, which live mode already serves and observes; remove it.`,
    );
    expect(PASS_THROUGH_CANDIDATES).not.toContain('firebase-admin');
    expect(startError(['firebase-admin/firestore'])).toContain('passThrough lists firebase-admin/firestore');
    expect(startError(['firebase-admin/firestore'])).toContain('already serves and observes firebase-admin');
    expect(startError(['firebase-admin/firestore'])).not.toContain('list firebase-admin');
  });

  test('takes an Admin SDK subpath live mode does not serve, such as firebase-admin/app-check and firebase-admin/messaging', () => {
    const admin = ['firebase-admin/app-check', 'firebase-admin/messaging', 'firebase-admin/remote-config'];
    expect(passThroughOption(ENTRY, ['firebase/functions', ...admin])).toEqual(['firebase/functions', ...admin]);
    expect(() => pyricWithSuppliedRows({}, { refusal: liveRefusal, passThrough: admin })).not.toThrow();
    for (const served of ['firebase-admin/app', 'firebase-admin/auth', 'firebase-admin/firestore', 'firebase-admin/database', 'firebase-admin/storage']) {
      expect(startError([served])).toContain(`passThrough lists ${served}, an Admin SDK subpath`);
    }
    expect(startError(['firebase-admin/lib/messaging'])).toContain('passThrough lists firebase-admin/lib/messaging, which is not');
  });

  test('gives each passed-through Admin SDK subpath a start line naming it, unobserved and billed', () => {
    const [line] = passThroughLines(ENTRY, ['firebase-admin/app-check'], livePassThroughLine);
    expect(line).toStartWith(`${ENTRY}: firebase-admin/app-check passes through`);
    expect(line).toContain('unobserved');
  });

  test("an unserved Admin subpath's refusal names the passThrough entry that loads it, and a served one's or a page's does not", () => {
    const refusal = liveRefusal('firebase-admin/messaging', 'node');
    expect((refusal as Error & { code?: string }).code).toBe(LIVE_REFUSED);
    expect(refusal.message).toContain("pyricLive({ passThrough: ['firebase-admin/messaging'] })");
    expect(liveRefusal('firebase-admin/auth', 'node').message).not.toContain('passThrough');
    expect(liveRefusal('firebase-admin/messaging', 'page').message).not.toContain('passThrough');
    expect(startError(['firebase'])).not.toContain('firebase-admin');
  });

  test('refuses an @firebase/* package name and names the import to list', () => {
    expect(startError(['@firebase/functions'])).toBe(
      `${ENTRY}: passThrough lists @firebase/functions, an SDK package name; list firebase/functions, the import apps write.`,
    );
  });

  test('refuses anything else, naming what it takes, and every problem at once', () => {
    const message = startError(['firebase', 'firebase/databse', 'firebase/compat/app', 7]);
    expect(message).toContain('passThrough lists firebase, which is not a Firebase import live mode can pass through. It takes firebase/analytics,');
    expect(message).toContain('passThrough lists firebase/databse, which is not');
    expect(message).toContain('passThrough lists firebase/compat/app, which is not');
    expect(message).toContain('passThrough lists 7, which is not an import name.');
    expect(startError('firebase/functions')).toBe(`${ENTRY}: passThrough takes a list of Firebase imports, such as ['firebase/functions'].`);
  });

  test('stops pyricLive() before it builds a plugin', () => {
    expect(() => pyricLive({ passThrough: ['firebase/firestore', 'firebase-admin/app'] })).toThrow(
      `${ENTRY}: passThrough lists firebase/firestore, which live mode already serves and observes; remove it. ` +
        'passThrough lists firebase-admin/app',
    );
    expect(() => pyricLive({ passThrough: ['firebase/database'] })).toThrow(
      `${ENTRY}: passThrough lists firebase/database, which live mode already serves and observes; remove it.`,
    );
    expect(() => pyricLive({ passThrough: ['firebase/ai'] })).toThrow(
      `${ENTRY}: passThrough lists firebase/ai, which live mode already serves and observes; remove it.`,
    );
    expect(() => pyricLive({ passThrough: ['firebase/messaging/sw'] })).toThrow(
      `${ENTRY}: passThrough lists firebase/messaging/sw, which live mode already serves and observes; remove it.`,
    );
    expect(() => pyricLive({ passThrough: ['firebase/functions'] })).not.toThrow();
    expect(() => pyricLive({ passThrough: ['firebase-admin'] })).toThrow(
      `${ENTRY}: passThrough lists firebase-admin, which live mode already serves and observes; remove it.`,
    );
  });

  test("is checked again at @pyric/cli's seam, so no supplier passes a served import or an Admin SDK subpath through", () => {
    for (const entry of ['firebase/auth', 'firebase/database', 'firebase/ai', 'firebase/messaging', 'firebase/messaging/sw', 'firebase-admin/app', '@firebase/database']) {
      expect(() => pyricWithSuppliedRows({}, { refusal: liveRefusal, passThrough: [entry] })).toThrow(`pyric: ${entry} cannot pass through`);
    }
    expect(() => pyricWithSuppliedRows({}, { refusal: liveRefusal, passThrough: ['firebase-admin'] })).not.toThrow();
  });
});

describe('a refused import that could pass through', () => {
  test('keeps the refusal and its code, and names the option that would let it load', () => {
    const hinted = withPassThroughHint(liveRefusal('firebase/functions', 'page'), 'firebase/functions');
    expect((hinted as Error & { code?: string }).code).toBe(LIVE_REFUSED);
    expect(hinted.message).toStartWith('@pyric/live: firebase/functions (Cloud Functions) is refused in live mode.');
    expect(hinted.message).toEndWith(
      " To load it from your installed Firebase SDK without observing it, list it in pyricLive({ passThrough: ['firebase/functions'] }); " +
        'its calls then go to production unobserved and still bill.',
    );
  });

  test('is named on the dev server with every import asked for so far, sorted', () => {
    expect(refusedImportsLine(ENTRY, ['firebase/functions'])).toBe(
      `${ENTRY}: a page imports firebase/functions (Cloud Functions), which live mode does not serve, so that import is refused. ` +
        "To load it from your installed Firebase SDK without observing it, start with pyricLive({ passThrough: ['firebase/functions'] }). " +
        'Its calls then go to production unobserved and still bill.',
    );
    const both = refusedImportsLine(ENTRY, ['firebase/functions', 'firebase/analytics', 'firebase/remote-config']);
    expect(both).toContain('a page imports firebase/analytics (Analytics), firebase/functions (Cloud Functions) and firebase/remote-config (Remote Config)');
    expect(both).toContain("start with pyricLive({ passThrough: ['firebase/analytics', 'firebase/functions', 'firebase/remote-config'] })");
  });
});

describe('the start lines for a pass-through list', () => {
  const REGISTER = '@pyric/live/register';

  test('give firebase-admin its own Admin line, one per entry, and keep one line for each other import', () => {
    const lines = passThroughLines(ENTRY, ['firebase/functions', 'firebase-admin'], livePassThroughLine);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith(`${ENTRY}: firebase/functions `);
    expect(lines[1]).toBe(adminPassThroughLine(ENTRY));
    expect(lines[1]).toStartWith(`${ENTRY}: firebase-admin `);
    expect(passThroughLines(REGISTER, ['firebase-admin'], livePassThroughLine)).toEqual([adminPassThroughLine(REGISTER)]);
    expect(adminPassThroughLine(REGISTER)).toStartWith(`${REGISTER}: firebase-admin `);
    expect(adminPassThroughLine(REGISTER).slice(REGISTER.length)).not.toBe(adminPassThroughLine(ENTRY).slice(ENTRY.length));
  });

  test('print no Admin line without firebase-admin in the list', () => {
    expect(passThroughLines(ENTRY, ['firebase/functions'], livePassThroughLine).some((line) => line.startsWith(`${ENTRY}: firebase-admin`))).toBe(false);
    expect(passThroughLines(ENTRY, [], livePassThroughLine)).toEqual([]);
  });
});

describe('the Admin start check', () => {
  /** A project folder that installs firebase-admin at `version`, or none. */
  function project(version: string | null): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-admin-check-')));
    if (version !== null) {
      mkdirSync(join(root, 'node_modules', 'firebase-admin'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'firebase-admin', 'package.json'), JSON.stringify({ name: 'firebase-admin', version }));
    }
    return root;
  }

  test('passes firebase-admin 13, and an app with no firebase-admin', () => {
    const admin13 = project('13.6.0');
    const none = project(null);
    try {
      expect(SUPPORTED_ADMIN_MAJOR).toBe(13);
      expect(installedAdminVersion(admin13, admin13)).toBe('13.6.0');
      expect(adminStartRefusal(admin13, admin13)).toBeNull();
      expect(installedAdminVersion(none, none)).toBeNull();
      expect(adminStartRefusal(none, none)).toBeNull();
    } finally {
      rmSync(admin13, { recursive: true, force: true });
      rmSync(none, { recursive: true, force: true });
    }
  });

  test('refuses another firebase-admin major at start', () => {
    const admin12 = project('12.7.0');
    try {
      expect(adminStartRefusal(admin12, admin12)).toContain('firebase-admin 12.7.0');
    } finally {
      rmSync(admin12, { recursive: true, force: true });
    }
  });

  test("keeps the Admin rows shut on Node 22, where require() never reaches the hooks, and says so in each Admin refusal", () => {
    expect(ADMIN_ROWS_NODE_MAJOR).toBe(23);
    expect(adminRowsNodeProblem('24.16.0')).toBeNull();
    expect(adminRowsNodeProblem('23.0.0')).toBeNull();
    expect(adminRowsNodeProblem('22.15.0')).toContain('Node 23 or later');
    expect(adminRowsNodeProblem('22.15.0')).toContain('22.15.0');
    const onThisNode = adminRowsNodeProblem();
    const refusal = liveRefusal('firebase-admin/app', 'node').message;
    if (onThisNode === null) expect(refusal).toContain("firebase-admin's app, Firestore, Auth");
    else expect(refusal).toContain(onThisNode);
  });
});

describe('the Admin rows, on by default', () => {
  const HOST = 'demo-host-project';
  const records: LiveCallRecord[] = [];
  let calls = 0;

  /** A stand-in for `@google-cloud/storage`'s classes, shaped as the Admin Storage row reads them. */
  class Bucket {
    constructor(readonly name: string, readonly storage: { projectId: string }) {}
    getFiles(): Promise<unknown[]> {
      calls += 1;
      return Promise.resolve([[]]);
    }
  }
  class File {
    constructor(readonly bucket: Bucket, readonly name: string) {}
    exists(): Promise<boolean[]> {
      calls += 1;
      return Promise.resolve([true]);
    }
  }
  const client = { projectId: HOST };
  serveHostProject(HOST);
  observeAdminRow('storage', { Bucket, File }, '/stand-in/storage/index.js', (record) => void records.push(record));

  test("refuses a default-form bucket of another project before the SDK runs, even when the client is the host's", async () => {
    const before = calls;
    for (const name of ['other-project.appspot.com', 'other-project.firebasestorage.app']) {
      const refused = await new File(new Bucket(name, client), 'notes/a.txt').exists().catch((error: unknown) => error);
      expect((refused as Error & { code?: string }).code).toBe(LIVE_REFUSED);
    }
    expect(calls).toBe(before);
  });

  test("observes a call to the host's default bucket, and leaves a custom-named bucket unjudged", async () => {
    const before = calls;
    expect(await new File(new Bucket(`${HOST}.appspot.com`, client), 'notes/a.txt').exists()).toEqual([true]);
    expect(await new Bucket('my-uploads', client).getFiles()).toEqual([[]]);
    expect(calls).toBe(before + 2);
    const names = records.map((record) => [record.name, record.sdk]);
    expect(names).toContainEqual(['File.exists', 'admin']);
    expect(names).toContainEqual(['Bucket.getFiles', 'admin']);
  });
});
