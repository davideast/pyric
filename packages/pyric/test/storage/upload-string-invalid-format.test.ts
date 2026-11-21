/**
 * Regression & offline `firebase/storage@12.19.0` parity tests for `#1962`:
 * `uploadString` with malformed `base64`, `base64url`, and `data_url` payloads
 * must synchronously throw `StorageError` with code `storage/invalid-format`
 * instead of `DOMException` code 5 across both `Buffer` and `atob` runtimes.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeApp, deleteApp } from 'firebase/app';
import * as fbStorage from 'firebase/storage';
import { initializeSandbox } from 'pyric/sandbox';
import {
  StorageError,
  getStorageSandbox,
  ref,
  uploadString,
  type StringFormat,
} from '../../src/storage/index.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const globals = globalThis as { Buffer?: unknown };
const realBuffer = globals.Buffer;

afterEach(() => {
  globals.Buffer = realBuffer;
});

function withoutBuffer<T>(body: () => T): T {
  delete globals.Buffer;
  try {
    return body();
  } finally {
    globals.Buffer = realBuffer;
  }
}

function captureSyncErrorCode(fn: () => unknown): {
  threwSync: boolean;
  code: unknown;
  instance: unknown;
} {
  try {
    const maybePromise = fn();
    if (
      typeof maybePromise === 'object' &&
      maybePromise !== null &&
      'catch' in maybePromise &&
      typeof (maybePromise as { catch: unknown }).catch === 'function'
    ) {
      (maybePromise as Promise<unknown>).catch(() => undefined);
    }
    return { threwSync: false, code: undefined, instance: undefined };
  } catch (err: unknown) {
    let code: unknown;
    if (typeof err === 'object' && err !== null && 'code' in err) {
      code = (err as { code: unknown }).code;
    }
    return { threwSync: true, code, instance: err };
  }
}

describe('uploadString invalid-format parity with firebase/storage@12.19.0 (#1962)', () => {
  const crossRuntimeCases: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
    readonly format: StringFormat;
  }> = [
    { label: 'non-base64 punctuation in base64', value: '!!!', format: 'base64' },
    { label: 'base64url dash in base64', value: 'aGVsbG8-', format: 'base64' },
    { label: 'base64url underscore in base64', value: 'aGVsbG8_', format: 'base64' },
    { label: 'non-base64 punctuation in base64url', value: '!!!', format: 'base64url' },
    { label: 'standard plus in base64url', value: 'aGVsbG8+', format: 'base64url' },
    { label: 'standard slash in base64url', value: 'aGVsbG8/', format: 'base64url' },
    { label: 'bad base64 payload in data_url', value: 'data:text/plain;base64,!!!', format: 'data_url' },
    { label: 'base64url payload in base64 data_url', value: 'data:text/plain;base64,aGVsbG8-', format: 'data_url' },
    { label: 'empty-mime bad base64 data_url', value: 'data:;base64,!!!', format: 'data_url' },
    { label: 'bad percent-encoding in raw data_url', value: 'data:text/plain,%ZZ', format: 'data_url' },
    { label: 'missing data: prefix in data_url', value: 'plain-text,hello', format: 'data_url' },
    { label: 'missing comma in data_url', value: 'data:text/plain;base64', format: 'data_url' },
  ];

  const browserPaddingCases: ReadonlyArray<{
    readonly value: string;
    readonly format: StringFormat;
  }> = [
    { value: 'a', format: 'base64' },
    { value: 'ab=', format: 'base64' },
    { value: '====', format: 'base64' },
    { value: 'a', format: 'base64url' },
    { value: 'data:text/plain;base64,a', format: 'data_url' },
  ];

  it('matches offline firebase/storage@12.19.0 error code storage/invalid-format on both Buffer and atob paths', async () => {
    const fbApp = initializeApp(
      { projectId: 'demo-1962', storageBucket: 'demo-1962.appspot.com' },
      `fb-1962-${crypto.randomUUID()}`,
    );
    const sandbox = initializeSandbox({});
    const pyStorage = getStorageSandbox(sandbox, {
      dbName: `pyric-1962-${crypto.randomUUID()}`,
      rules: OPEN_RULES,
    });

    try {
      const fbRef = fbStorage.ref(fbStorage.getStorage(fbApp), 'items/bad.bin');
      const pyRef = ref(pyStorage, 'items/bad.bin');

      for (const entry of crossRuntimeCases) {
        const upstream = captureSyncErrorCode(() =>
          fbStorage.uploadString(fbRef, entry.value, entry.format),
        );
        expect(upstream.threwSync).toBe(true);
        expect(upstream.code).toBe('storage/invalid-format');

        const withBuf = captureSyncErrorCode(() =>
          uploadString(pyRef, entry.value, entry.format),
        );
        expect(withBuf.threwSync).toBe(true);
        expect(withBuf.instance).toBeInstanceOf(StorageError);
        expect(withBuf.code).toBe('storage/invalid-format');

        const noBuf = withoutBuffer(() =>
          captureSyncErrorCode(() => uploadString(pyRef, entry.value, entry.format)),
        );
        expect(noBuf.threwSync).toBe(true);
        expect(noBuf.instance).toBeInstanceOf(StorageError);
        expect(noBuf.code).toBe('storage/invalid-format');
      }

      for (const entry of browserPaddingCases) {
        const withBuf = captureSyncErrorCode(() =>
          uploadString(pyRef, entry.value, entry.format),
        );
        expect(withBuf.threwSync).toBe(true);
        expect(withBuf.instance).toBeInstanceOf(StorageError);
        expect(withBuf.code).toBe('storage/invalid-format');

        const noBuf = withoutBuffer(() =>
          captureSyncErrorCode(() => uploadString(pyRef, entry.value, entry.format)),
        );
        expect(noBuf.threwSync).toBe(true);
        expect(noBuf.instance).toBeInstanceOf(StorageError);
        expect(noBuf.code).toBe('storage/invalid-format');
      }
    } finally {
      await deleteApp(fbApp);
      sandbox.dispose();
    }
  });
});
