/**
 * `pyricLive({ passThrough })`: which imports the option takes, the start-time
 * error for each it does not, and what a refused import tells the app and the
 * dev server about the option. The pass-through itself, a listed import
 * loading the installed SDK on a page, runs through Vite and Chromium in
 * `test/apps/live-pass-through`.
 */
import { describe, expect, test } from 'bun:test';
import { INSTALLED_SDK_SPECIFIERS, SDK_MODULES, pyricWithSuppliedRows } from '@pyric/cli/vite/internal/supplied-rows';
import {
  LIVE_REFUSED,
  PASS_THROUGH_CANDIDATES,
  liveRefusal,
  passThroughOption,
  refusedImportsLine,
  withPassThroughHint,
} from '../src/refusal.js';
import { pyricLive } from '../src/vite.js';

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
      'firebase/ai', 'firebase/analytics', 'firebase/database', 'firebase/functions', 'firebase/messaging',
      'firebase/messaging/sw', 'firebase/performance', 'firebase/remote-config', 'firebase/storage',
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
    expect(passThroughOption(ENTRY, ['firebase/database', 'firebase/ai', 'firebase/database'])).toEqual(['firebase/database', 'firebase/ai']);
  });

  test('refuses an import live mode already serves', () => {
    for (const served of INSTALLED_SDK_SPECIFIERS) {
      expect(startError([served])).toBe(`${ENTRY}: passThrough lists ${served}, which live mode already serves and observes; remove it.`);
    }
  });

  test('refuses firebase-admin and every subpath of it', () => {
    for (const admin of ['firebase-admin', 'firebase-admin/firestore']) {
      expect(startError([admin])).toBe(
        `${ENTRY}: passThrough lists ${admin}, which never passes through: live mode refuses the Admin SDK in every process.`,
      );
    }
  });

  test('refuses an @firebase/* package name and names the import to list', () => {
    expect(startError(['@firebase/database'])).toBe(
      `${ENTRY}: passThrough lists @firebase/database, an SDK package name; list firebase/database, the import apps write.`,
    );
  });

  test('refuses anything else, naming what it takes, and every problem at once', () => {
    const message = startError(['firebase', 'firebase/databse', 'firebase/compat/app', 7]);
    expect(message).toContain('passThrough lists firebase, which is not a Firebase import live mode can pass through. It takes firebase/ai,');
    expect(message).toContain('passThrough lists firebase/databse, which is not');
    expect(message).toContain('passThrough lists firebase/compat/app, which is not');
    expect(message).toContain('passThrough lists 7, which is not an import name.');
    expect(startError('firebase/database')).toBe(`${ENTRY}: passThrough takes a list of Firebase imports, such as ['firebase/database'].`);
  });

  test('stops pyricLive() before it builds a plugin', () => {
    expect(() => pyricLive({ passThrough: ['firebase/firestore', 'firebase-admin'] })).toThrow(
      `${ENTRY}: passThrough lists firebase/firestore, which live mode already serves and observes; remove it. ` +
        'passThrough lists firebase-admin, which never passes through',
    );
    expect(() => pyricLive({ passThrough: ['firebase/database'] })).not.toThrow();
  });

  test("is checked again at @pyric/cli's seam, so no supplier passes a served import or firebase-admin through", () => {
    for (const entry of ['firebase/auth', 'firebase-admin', '@firebase/database']) {
      expect(() => pyricWithSuppliedRows({}, { refusal: liveRefusal, passThrough: [entry] })).toThrow(`pyric: ${entry} cannot pass through`);
    }
  });
});

describe('a refused import that could pass through', () => {
  test('keeps the refusal and its code, and names the option that would let it load', () => {
    const hinted = withPassThroughHint(liveRefusal('firebase/database', 'page'), 'firebase/database');
    expect((hinted as Error & { code?: string }).code).toBe(LIVE_REFUSED);
    expect(hinted.message).toStartWith('@pyric/live: firebase/database (Realtime Database) is refused in live mode.');
    expect(hinted.message).toEndWith(
      " To load it from your installed Firebase SDK without observing it, list it in pyricLive({ passThrough: ['firebase/database'] }); " +
        'its calls then go to production unobserved and still bill.',
    );
  });

  test('is named on the dev server with every import asked for so far, sorted', () => {
    expect(refusedImportsLine(ENTRY, ['firebase/database'])).toBe(
      `${ENTRY}: a page imports firebase/database (Realtime Database), which live mode does not serve, so that import is refused. ` +
        "To load it from your installed Firebase SDK without observing it, start with pyricLive({ passThrough: ['firebase/database'] }). " +
        'Its calls then go to production unobserved and still bill.',
    );
    const both = refusedImportsLine(ENTRY, ['firebase/database', 'firebase/ai', 'firebase/messaging']);
    expect(both).toContain('a page imports firebase/ai (Firebase AI Logic), firebase/database (Realtime Database) and firebase/messaging (Cloud Messaging)');
    expect(both).toContain("start with pyricLive({ passThrough: ['firebase/ai', 'firebase/database', 'firebase/messaging'] })");
  });
});
