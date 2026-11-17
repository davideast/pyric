/**
 * Generative `firebase-admin/storage` (`@google-cloud/storage`) vs
 * `pyric-admin/storage` argument differential suite across both in-process and
 * SharedWorker JSON-wire remote sandbox arms.
 */

import 'fake-indexeddb/auto';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'bun:test';
import admin from 'firebase-admin';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getStorage as getUpstreamStorage } from 'firebase-admin/storage';
import { initializeSandbox } from 'pyric/sandbox';
import pyricAdmin, { storage as legacyStorage } from '../../src/index.js';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  getDownloadURL,
  getStorage,
  type Bucket,
  type File,
  type Storage,
} from '../../src/storage/index.js';

import {
  emitTypeWrongnessCandidates,
  generateMethodArgumentCases,
  type CandidateValue,
  type GeneratedArgumentCase,
} from '../argument-generator/argument-combinators.js';
import { STORAGE_ARMS } from './arms.js';
import {
  STORAGE_DIFF_BUCKET,
  STORAGE_EXISTING_PATH,
  STORAGE_MISSING_PATH,
  buildStorageMethodSchemas,
} from './storage-argument-schemas.js';
import {
  captureStorageOutcome,
  createOfflineUpstreamStorageHarness,
  isDocumentedStorageSandboxDivergence,
  type NormalizedStorageOutcome,
} from './upstream-storage-oracle.js';

function invokeAppAccessor(
  accessor: (app?: never) => unknown,
  candidate: CandidateValue,
): unknown {
  if (candidate.label === 'undefined') {
    return accessor();
  }
  return accessor(candidate.build() as never);
}

function compareStorageOutcomes(
  contextLabel: string,
  methodName: string,
  rawArgs: readonly unknown[],
  upstream: NormalizedStorageOutcome,
  pyric: NormalizedStorageOutcome,
): string | null {
  if (isDocumentedStorageSandboxDivergence(methodName, rawArgs, upstream, pyric)) {
    return null;
  }

  if (upstream.accepted !== pyric.accepted) {
    return `${contextLabel}: acceptance mismatch (upstream=${upstream.accepted} err=${upstream.errorKind}:${upstream.code ?? upstream.message}, pyric=${pyric.accepted} err=${pyric.errorKind}:${pyric.code ?? pyric.message})`;
  }

  if (!upstream.accepted && !pyric.accepted) {
    if (
      (methodName === 'createReadStream' || methodName === 'createWriteStream') &&
      upstream.threwSynchronously !== pyric.threwSynchronously
    ) {
      return `${contextLabel}: sync-throw mismatch (upstreamSync=${upstream.threwSynchronously}, pyricSync=${pyric.threwSynchronously})`;
    }
    if (upstream.errorKind === 'TypeError' || pyric.errorKind === 'TypeError') {
      if (upstream.errorKind === 'TypeError' && pyric.errorKind === 'TypeError') {
        return null;
      }
      return `${contextLabel}: TypeError mismatch (upstream=${upstream.errorKind}:${upstream.message}, pyric=${pyric.errorKind}:${pyric.message})`;
    }
    if (upstream.errorKind === 'FirebaseError' || pyric.errorKind === 'FirebaseError') {
      if (upstream.code !== undefined && upstream.code === pyric.code) {
        return null;
      }
      return `${contextLabel}: firebase error code mismatch (upstream=${upstream.errorKind}:${upstream.code}, pyric=${pyric.errorKind}:${pyric.code})`;
    }
    return null;
  }

  return null;
}

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app).catch(() => {});
  for (const app of getUpstreamApps()) await deleteUpstreamApp(app).catch(() => {});
});

describe('generative Admin Storage argument differential: getStorage, storage, and getDownloadURL', () => {
  it('matches firebase-admin on getStorage & storage across app-handle wrong types, no-app, default-app, and deleted-app states', async () => {
    const mismatches: string[] = [];

    for (const candidate of emitTypeWrongnessCandidates()) {
      const uGet = await captureStorageOutcome(() =>
        invokeAppAccessor(getUpstreamStorage as (app?: never) => unknown, candidate),
      );
      const pGet = await captureStorageOutcome(() =>
        invokeAppAccessor(getStorage as (app?: never) => unknown, candidate),
      );
      const uLegacy = await captureStorageOutcome(() =>
        invokeAppAccessor(admin.storage as (app?: never) => unknown, candidate),
      );
      const pLegacy = await captureStorageOutcome(() =>
        invokeAppAccessor(legacyStorage as (app?: never) => unknown, candidate),
      );
      const pDefaultLegacy = await captureStorageOutcome(() =>
        invokeAppAccessor(pyricAdmin.storage as (app?: never) => unknown, candidate),
      );

      const getDiff = compareStorageOutcomes(
        `getStorage(${candidate.label})`,
        'getStorage',
        [candidate.value],
        uGet,
        pGet,
      );
      if (getDiff !== null) mismatches.push(getDiff);

      const legDiff = compareStorageOutcomes(
        `storage(${candidate.label})`,
        'storage',
        [candidate.value],
        uLegacy,
        pLegacy,
      );
      if (legDiff !== null) mismatches.push(legDiff);

      const defLegDiff = compareStorageOutcomes(
        `admin.storage(${candidate.label})`,
        'storage',
        [candidate.value],
        uLegacy,
        pDefaultLegacy,
      );
      if (defLegDiff !== null) mismatches.push(defLegDiff);
    }

    const upstreamHarness = createOfflineUpstreamStorageHarness(STORAGE_DIFF_BUCKET);
    const defaultUpstream = initializeUpstreamApp({
      projectId: 'demo-project',
      storageBucket: STORAGE_DIFF_BUCKET,
      credential: upstreamHarness.app.options.credential,
    });
    const sandbox = initializeSandbox({ projectId: 'demo-project' });
    const defaultPyric = initializeApp({ sandbox, storageBucket: STORAGE_DIFF_BUCKET });
    try {
      const uDef = await captureStorageOutcome(() => getUpstreamStorage());
      const pDef = await captureStorageOutcome(() => getStorage());
      const defDiff = compareStorageOutcomes('getStorage([DEFAULT])', 'getStorage', [], uDef, pDef);
      if (defDiff !== null) mismatches.push(defDiff);
    } finally {
      await deleteUpstreamApp(defaultUpstream);
      await deleteApp(defaultPyric);
      await upstreamHarness.dispose();
      sandbox.dispose();
    }

    const delHarness = createOfflineUpstreamStorageHarness(STORAGE_DIFF_BUCKET);
    const delSandbox = initializeSandbox({ projectId: 'demo-project' });
    const delUpstream = initializeUpstreamApp(
      {
        projectId: 'demo-project',
        storageBucket: STORAGE_DIFF_BUCKET,
        credential: delHarness.app.options.credential,
      },
      'deleted-upstream-storage',
    );
    const delPyric = initializeApp(
      { sandbox: delSandbox, storageBucket: STORAGE_DIFF_BUCKET },
      'deleted-pyric-storage',
    );
    await deleteUpstreamApp(delUpstream);
    await deleteApp(delPyric);
    try {
      const uDel = await captureStorageOutcome(() => getUpstreamStorage(delUpstream));
      const pDel = await captureStorageOutcome(() => getStorage(delPyric));
      const delDiff = compareStorageOutcomes(
        'getStorage(deletedApp)',
        'getStorage',
        [delPyric],
        uDel,
        pDel,
      );
      if (delDiff !== null) mismatches.push(delDiff);
    } finally {
      await delHarness.dispose();
      delSandbox.dispose();
    }

    expect(mismatches).toEqual([]);
  });
});

describe.each(STORAGE_ARMS)(
  'generative Admin Storage argument differential (%s arm)',
  (_armLabel, openArmApp) => {
    it('matches firebase-admin on bucket(name?) and file(path) across wrong types and gs:// / slash grammars', async () => {
      const app = openArmApp({ storageBucket: STORAGE_DIFF_BUCKET });
      const pyricStorage = getStorage(app);
      const upstream = createOfflineUpstreamStorageHarness(STORAGE_DIFF_BUCKET);

      try {
        const schemas = buildStorageMethodSchemas({
          makeDestBucket: () => pyricStorage.bucket('dest-bucket'),
          makeDestFile: () => pyricStorage.bucket('dest-bucket').file('dest.txt'),
        });
        const mismatches: string[] = [];

        for (const testCase of generateMethodArgumentCases(schemas.bucket)) {
          const uArgs = testCase.buildArgs();
          const pArgs = testCase.buildArgs();
          const uOut = await captureStorageOutcome(() =>
            (upstream.svc.bucket as (...a: unknown[]) => unknown)(...uArgs),
          );
          const pOut = await captureStorageOutcome(() =>
            (pyricStorage.bucket as (...a: unknown[]) => unknown)(...pArgs),
          );
          const diff = compareStorageOutcomes(
            `bucket:${testCase.label}`,
            'bucket',
            pArgs,
            uOut,
            pOut,
          );
          if (diff !== null) mismatches.push(diff);
        }

        const upBucket = upstream.svc.bucket(STORAGE_DIFF_BUCKET);
        const pyBucket = pyricStorage.bucket(STORAGE_DIFF_BUCKET);
        for (const testCase of generateMethodArgumentCases(schemas.file)) {
          const uArgs = testCase.buildArgs();
          const pArgs = testCase.buildArgs();
          const uOut = await captureStorageOutcome(() =>
            (upBucket.file as (...a: unknown[]) => unknown)(...uArgs),
          );
          const pOut = await captureStorageOutcome(() =>
            (pyBucket.file as (...a: unknown[]) => unknown)(...pArgs),
          );
          const diff = compareStorageOutcomes(
            `file:${testCase.label}`,
            'file',
            pArgs,
            uOut,
            pOut,
          );
          if (diff !== null) mismatches.push(diff);
        }

        expect(mismatches).toEqual([]);
      } finally {
        await upstream.dispose();
      }
    });

    it('matches firebase-admin on getDownloadURL across wrong types, existing files, and missing files', async () => {
      const app = openArmApp({ storageBucket: STORAGE_DIFF_BUCKET });
      const pyricStorage = getStorage(app);
      const pyBucket = pyricStorage.bucket(STORAGE_DIFF_BUCKET);
      await pyBucket.file(STORAGE_EXISTING_PATH).save('hello world', { contentType: 'text/plain' });

      const upstream = createOfflineUpstreamStorageHarness(STORAGE_DIFF_BUCKET);
      upstream.resetState([
        {
          bucket: STORAGE_DIFF_BUCKET,
          name: STORAGE_EXISTING_PATH,
          content: 'hello world',
          contentType: 'text/plain',
          downloadTokens: 'tok-1',
        },
      ]);

      try {
        const mismatches: string[] = [];
        for (const wrong of emitTypeWrongnessCandidates()) {
          const uOut = await captureStorageOutcome(
            () => upstream.getDownloadURL(wrong.build() as never),
            upstream.didReachTransport,
          );
          const pOut = await captureStorageOutcome(() => getDownloadURL(wrong.build() as never));
          const diff = compareStorageOutcomes(
            `getDownloadURL(${wrong.label})`,
            'getDownloadURL',
            [wrong.value],
            uOut,
            pOut,
          );
          if (diff !== null) mismatches.push(diff);
        }

        for (const path of [STORAGE_EXISTING_PATH, STORAGE_MISSING_PATH]) {
          upstream.resetTransportFlag();
          const uOut = await captureStorageOutcome(
            () => upstream.getDownloadURL(upstream.svc.bucket(STORAGE_DIFF_BUCKET).file(path)),
            upstream.didReachTransport,
          );
          const pOut = await captureStorageOutcome(() => getDownloadURL(pyBucket.file(path)));
          const diff = compareStorageOutcomes(
            `getDownloadURL(file=${path})`,
            'getDownloadURL',
            [path],
            uOut,
            pOut,
          );
          if (diff !== null) mismatches.push(diff);
        }

        expect(mismatches).toEqual([]);
      } finally {
        await upstream.dispose();
      }
    });

    it('matches firebase-admin on Bucket getFiles & deleteFiles and File save, download, createReadStream, createWriteStream, createResumableUpload, delete, exists, getMetadata, setMetadata, copy, move, getSignedUrl', async () => {
      const app = openArmApp({ storageBucket: STORAGE_DIFF_BUCKET });
      const pyricStorage: Storage = getStorage(app);
      const upstream = createOfflineUpstreamStorageHarness(STORAGE_DIFF_BUCKET);

      try {
        const pyBucket: Bucket = pyricStorage.bucket(STORAGE_DIFF_BUCKET);
        const upBucket = upstream.svc.bucket(STORAGE_DIFF_BUCKET);

        let targetSide: 'upstream' | 'pyric' = 'pyric';
        const schemas = buildStorageMethodSchemas({
          makeDestBucket: () => {
            if (targetSide === 'upstream') {
              return upstream.svc.bucket('archive-bucket');
            }
            return pyricStorage.bucket('archive-bucket');
          },
          makeDestFile: () => {
            if (targetSide === 'upstream') {
              return upstream.svc.bucket('archive-bucket').file('copied-file.txt');
            }
            return pyricStorage.bucket('archive-bucket').file('copied-file.txt');
          },
        });

        const MUTATING_METHODS = new Set([
          'deleteFiles',
          'save',
          'createWriteStream',
          'delete',
          'setMetadata',
          'copy',
          'move',
        ]);
        let needsReseed = true;

        const ensureSeeded = async (): Promise<void> => {
          if (!needsReseed) return;
          await pyBucket.file(STORAGE_EXISTING_PATH).save('hello world', {
            contentType: 'text/plain',
          });
          upstream.resetState([
            {
              bucket: STORAGE_DIFF_BUCKET,
              name: STORAGE_EXISTING_PATH,
              content: 'hello world',
              contentType: 'text/plain',
              downloadTokens: 'tok-1',
            },
          ]);
          needsReseed = false;
        };

        const mismatches: string[] = [];

        const runBucketCases = async (cases: readonly GeneratedArgumentCase[]): Promise<void> => {
          for (const testCase of cases) {
            await ensureSeeded();
            upstream.resetTransportFlag();
            targetSide = 'upstream';
            const uArgs = testCase.buildArgs();
            targetSide = 'pyric';
            const pArgs = testCase.buildArgs();

            const uFn = (upBucket as unknown as Record<string, (...a: unknown[]) => unknown>)[
              testCase.methodName
            ];
            const pFn = (pyBucket as unknown as Record<string, (...a: unknown[]) => unknown>)[
              testCase.methodName
            ];

            const uOut = await captureStorageOutcome(
              () => uFn?.apply(upBucket, uArgs),
              upstream.didReachTransport,
            );
            const pOut = await captureStorageOutcome(() => pFn?.apply(pyBucket, pArgs));
            if (MUTATING_METHODS.has(testCase.methodName) && (uOut.accepted || pOut.accepted)) {
              needsReseed = true;
            }
            const diff = compareStorageOutcomes(
              `${testCase.methodName}:${testCase.label}`,
              testCase.methodName,
              pArgs,
              uOut,
              pOut,
            );
            if (diff !== null) mismatches.push(diff);
          }
        };

        const runFileCases = async (
          filePath: string,
          cases: readonly GeneratedArgumentCase[],
        ): Promise<void> => {
          for (const testCase of cases) {
            await ensureSeeded();
            upstream.resetTransportFlag();
            const upFile = upBucket.file(filePath);
            const pyFile: File = pyBucket.file(filePath);

            targetSide = 'upstream';
            const uArgs = testCase.buildArgs();
            targetSide = 'pyric';
            const pArgs = testCase.buildArgs();

            const invokeTargetMethod = (
              target: unknown,
              args: readonly unknown[],
              isUpstream: boolean,
            ): unknown => {
              if (
                isUpstream &&
                testCase.methodName === 'setMetadata' &&
                (args.length === 0 || (args.length === 1 && args[0] === undefined))
              ) {
                return ((target as { setMetadata: (...a: unknown[]) => unknown }).setMetadata)(
                  undefined,
                  {},
                );
              }
              const fn = (target as Record<string, (...a: unknown[]) => unknown>)[
                testCase.methodName
              ];
              const rawResult = fn?.apply(target, [...args]);
              if (testCase.methodName === 'createReadStream') {
                const stream = rawResult as Readable;
                return new Promise<void>((resolve, reject) => {
                  stream.once('error', reject);
                  stream.once('end', () => resolve());
                  stream.resume();
                });
              }
              if (testCase.methodName === 'createWriteStream') {
                const stream = rawResult as Writable;
                return new Promise<void>((resolve, reject) => {
                  stream.once('error', reject);
                  stream.once('finish', () => resolve());
                  stream.end('abc');
                });
              }
              return rawResult;
            };

            const uOut = await captureStorageOutcome(
              () => invokeTargetMethod(upFile, uArgs, true),
              upstream.didReachTransport,
            );
            const pOut = await captureStorageOutcome(() =>
              invokeTargetMethod(pyFile, pArgs, false),
            );
            if (
              filePath === STORAGE_EXISTING_PATH &&
              MUTATING_METHODS.has(testCase.methodName) &&
              (uOut.accepted || pOut.accepted)
            ) {
              needsReseed = true;
            }
            const diff = compareStorageOutcomes(
              `${testCase.methodName}(${filePath}):${testCase.label}`,
              testCase.methodName,
              pArgs,
              uOut,
              pOut,
            );
            if (diff !== null) mismatches.push(diff);
          }
        };

        await runBucketCases([
          ...generateMethodArgumentCases(schemas.getFiles),
          ...generateMethodArgumentCases(schemas.deleteFiles),
        ]);

        await runFileCases(STORAGE_EXISTING_PATH, [
          ...generateMethodArgumentCases(schemas.save),
          ...generateMethodArgumentCases(schemas.download),
          ...generateMethodArgumentCases(schemas.delete),
          ...generateMethodArgumentCases(schemas.exists),
          ...generateMethodArgumentCases(schemas.getMetadata),
          ...generateMethodArgumentCases(schemas.setMetadata),
          ...generateMethodArgumentCases(schemas.copy),
          ...generateMethodArgumentCases(schemas.move),
          ...generateMethodArgumentCases(schemas.getSignedUrl),
          ...generateMethodArgumentCases(schemas.createReadStream),
          ...generateMethodArgumentCases(schemas.createWriteStream),
          ...generateMethodArgumentCases(schemas.createResumableUpload),
        ]);

        await runFileCases(STORAGE_MISSING_PATH, [
          ...generateMethodArgumentCases(schemas.download).slice(0, 3),
          ...generateMethodArgumentCases(schemas.createReadStream).slice(0, 3),
          ...generateMethodArgumentCases(schemas.delete).slice(0, 2),
          ...generateMethodArgumentCases(schemas.exists).slice(0, 2),
          ...generateMethodArgumentCases(schemas.getMetadata).slice(0, 2),
          ...generateMethodArgumentCases(schemas.setMetadata).slice(0, 3),
          ...generateMethodArgumentCases(schemas.copy).slice(0, 3),
        ]);

        expect(mismatches).toEqual([]);

        // Verify literal gs:// object paths round-trip bytes and list verbatim on both arms.
        const literalBucket = pyricStorage.bucket('literal-key-bucket');
        await literalBucket.file('seed.txt').save(new Set(['seed-', 'payload']) as never);
        await literalBucket.file('gs://other-bucket/sub/file.txt').save('saved-literal');
        await literalBucket.file('seed.txt').copy('gs://UpperBucket/a.txt');
        await literalBucket.file('seed.txt').copy('gs://archive-bucket/');
        const [listedLiteralFiles] = await literalBucket.getFiles();
        expect(listedLiteralFiles.map((f) => f.name)).toEqual([
          'gs://UpperBucket/a.txt',
          'gs://archive-bucket/',
          'gs://other-bucket/sub/file.txt',
          'seed.txt',
        ]);
        const [upperBytes] = await literalBucket.file('gs://UpperBucket/a.txt').download();
        expect(upperBytes.toString('utf8')).toBe('seed-payload');

        const syncThrowRead = await captureStorageOutcome(() =>
          literalBucket.file('seed.txt').createReadStream({ start: 0, validation: true }),
        );
        expect(syncThrowRead.threwSynchronously).toBe(true);
        const asyncErrRead = await captureStorageOutcome(() => {
          const s = literalBucket.file('missing-stream.txt').createReadStream();
          return new Promise<void>((resolve, reject) => {
            s.once('error', reject);
            s.once('end', () => resolve());
            s.resume();
          });
        });
        expect(asyncErrRead.threwSynchronously).toBe(false);
      } finally {
        await upstream.dispose();
      }
    });
  },
);
