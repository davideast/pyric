/**
 * The storage methods that read the bucket back rather than their own claim.
 *
 * Each one is judged against something outside itself: the URL against the
 * library call it wraps and against the bytes the object holds, the metadata
 * against a later read and against a pinned clock, the cross-service posture
 * against a rules simulation that reaches into Firestore, and an upload from a
 * file against the file's own bytes.
 */
import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDownloadURL, ref } from 'pyric/storage';

import { storageFor } from '../../../src/bridge/surface/service-handles.js';
import {
  ALLOW_PRODUCTION_FLAG,
} from '../../../src/bridge/surface/method-effects.js';
import { ctx, finishHandlerSuite, projectDir, run, sandbox } from './handler-harness.js';

afterAll(() => finishHandlerSuite('storage'));

/** A storage ruleset whose decision is a Firestore lookup, so the posture decides it. */
const CROSS_SERVICE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if firestore.exists(/databases/(default)/documents/flags/uploads);
    }
  }
}`;

/** Write one file into the project directory and return the path relative to it. */
function plantFile(relative: string, contents: string): string {
  const absolute = join(projectDir, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return relative;
}

it('mints a download URL that carries the object the library would hand back', async () => {
  const payload = Buffer.from('a download').toString('base64');
  expect(
    (await run('storage.uploadBytes', { path: 'downloads/note.txt', contentBase64: payload })).ok,
  ).toBe(true);

  const minted = await run('storage.getDownloadURL', { path: 'downloads/note.txt' });
  expect(minted.ok).toBe(true);
  const { url } = minted.data as { url: string };

  // The URL is the library's, not a string this method assembled.
  expect(url).toBe(await getDownloadURL(ref(storageFor(ctx), 'downloads/note.txt')));

  // And it resolves: the sandbox mints a data URI, so the payload it carries
  // is the object's own bytes, which is what getBytes reads back.
  const [head, carried] = url.split(',');
  expect(head).toStartWith('data:text/plain');
  expect(head).toEndWith(';base64');
  const read = await run('storage.getBytes', { path: 'downloads/note.txt' });
  expect(carried).toBe((read.data as { contentBase64: string }).contentBase64);
  expect(Buffer.from(carried ?? '', 'base64').toString('utf8')).toBe('a download');

  expect((await run('storage.deleteObject', { path: 'downloads/note.txt' })).ok).toBe(true);
});

it('updates metadata that a later read returns, stamped with the sandbox clock', async () => {
  const payload = Buffer.from('metadata subject').toString('base64');
  await run('storage.uploadBytes', { path: 'meta/report.txt', contentBase64: payload });

  const pinned = '2026-04-01T09:30:00.000Z';
  expect((await run('sandbox.setClock', { isoTime: pinned })).ok).toBe(true);

  const updated = await run('storage.updateMetadata', {
    path: 'meta/report.txt',
    metadata: {
      cacheControl: 'max-age=600',
      contentLanguage: 'en',
      customMetadata: { owner: 'dana' },
    },
  });
  expect(updated.ok).toBe(true);

  const readBack = await run('storage.getMetadata', { path: 'meta/report.txt' });
  const metadata = (readBack.data as { metadata: Record<string, unknown> }).metadata;
  expect(metadata.cacheControl).toBe('max-age=600');
  expect(metadata.contentLanguage).toBe('en');
  expect(metadata.customMetadata).toEqual({ owner: 'dana' });
  expect(metadata.updated).toBe(pinned);
  // The bytes are untouched by a metadata write.
  expect((metadata as { size: number }).size).toBe(Buffer.from('metadata subject').byteLength);

  expect((await run('sandbox.resetClock', {})).ok).toBe(true);
  expect((await run('storage.deleteObject', { path: 'meta/report.txt' })).ok).toBe(true);
});

it('flips a rules simulation that reads Firestore between the two IAM postures', async () => {
  sandbox.admin.setDocument('flags/uploads', { on: true });

  const simulate = () =>
    run('rules.simulate', {
      service: 'storage',
      operation: 'get',
      path: 'uploads/whatever.txt',
      rules: CROSS_SERVICE_RULES,
    });

  const granted = await simulate();
  expect((granted.data as { allowed: boolean }).allowed).toBe(true);

  const denied = await run('storage.setCrossServiceIam', { mode: 'denied' });
  expect(denied.ok).toBe(true);
  const underDenial = await simulate();
  expect((underDenial.data as { allowed: boolean }).allowed).toBe(false);
  expect(JSON.stringify((underDenial.data as { reasons: string[] }).reasons)).toContain(
    'firebaserules.firestoreServiceAgent',
  );

  expect((await run('storage.setCrossServiceIam', { mode: 'granted' })).ok).toBe(true);
  expect(((await simulate()).data as { allowed: boolean }).allowed).toBe(true);
});

it('uploads the bytes of a file in the project and infers its content type', async () => {
  const source = plantFile('exports/report.csv', 'name,total\nalice,10\n');

  const uploaded = await run('storage.uploadBytes', {
    path: 'exports/report.csv',
    sourcePath: source,
  });
  expect(uploaded.ok).toBe(true);
  expect((uploaded.data as { contentType: string }).contentType).toBe('text/csv');

  const read = await run('storage.getBytes', { path: 'exports/report.csv' });
  expect(
    Buffer.from((read.data as { contentBase64: string }).contentBase64, 'base64').toString('utf8'),
  ).toBe('name,total\nalice,10\n');

  expect((await run('storage.deleteObject', { path: 'exports/report.csv' })).ok).toBe(true);
});

it('names the metadata content type over the one the extension implies', async () => {
  const source = plantFile('exports/typed.csv', 'a,b\n');
  const uploaded = await run('storage.uploadBytes', {
    path: 'exports/typed.csv',
    sourcePath: source,
    metadata: { contentType: 'application/octet-stream' },
  });
  expect((uploaded.data as { contentType: string }).contentType).toBe('application/octet-stream');
  expect((await run('storage.deleteObject', { path: 'exports/typed.csv' })).ok).toBe(true);
});

it('refuses an upload that names both payload forms, and one that names neither', async () => {
  const both = await run('storage.uploadBytes', {
    path: 'uploads/ambiguous.txt',
    contentBase64: Buffer.from('x').toString('base64'),
    sourcePath: 'exports/report.csv',
  });
  expect(both.ok).toBe(false);
  expect(both.summary).toContain('one payload');

  const neither = await run('storage.uploadBytes', { path: 'uploads/empty.txt' });
  expect(neither.ok).toBe(false);
  expect(neither.summary).toContain('no payload');
});

it('refuses a source path that escapes the project directory', async () => {
  const escaping = await run('storage.uploadBytes', {
    path: 'uploads/escaped.txt',
    sourcePath: '../../etc/hosts',
  });
  expect(escaping.ok).toBe(false);
  expect(escaping.summary).toContain('outside the project directory');
});

it('reports a source path that names no file rather than uploading nothing', async () => {
  const absent = await run('storage.uploadBytes', {
    path: 'uploads/absent.txt',
    sourcePath: 'exports/not-here.csv',
  });
  expect(absent.ok).toBe(false);
  expect(absent.summary).toContain('exports/not-here.csv');
});

it('refuses the two control-plane methods on a server that did not opt in', async () => {
  const status = await run('storage.status', { confirm: true });
  expect(status.ok).toBe(false);
  expect(status.summary).toContain(ALLOW_PRODUCTION_FLAG);

  const provision = await run('storage.provision', { confirm: true });
  expect(provision.ok).toBe(false);
  expect(provision.summary).toContain(ALLOW_PRODUCTION_FLAG);
});
