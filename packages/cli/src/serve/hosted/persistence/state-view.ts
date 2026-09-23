import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../../worker/protocol/storage.js';
import { MAX_INLINE_EXPORT_STORAGE_BYTES, StateExportTooLargeError } from './export-limit.js';
import { bundleRecords, parseBundle, serializeToBuckets } from 'pyric/sandbox';
import { decodeImportBundle, seedUserSchema, storedMetadataSchema } from 'pyric/sandbox/internal';
import { z } from 'zod';
import { join } from 'node:path';
import type { StateStore, PyricStateFile, StateSection } from '../../state-store.js';
import type { openHostedDatabase } from './database.js';
import { inTransaction, sqlText } from './sqlite.js';
import type { PutStorageBytes } from './storage.js';
import { validateHostedDatabase } from './validate.js';

type Database = Awaited<ReturnType<typeof openHostedDatabase>>;
const authSection = z.object({ users: z.array(seedUserSchema) });
const objectRecords = z.array(z.object({ dataBase64: z.string(), blobType: z.string(), metadata: storedMetadataSchema }));

/** Portable JSON is an explicit view of SQLite, never a second working store. */
export function createHostedStateView(projectDir: string, directory: string, database: Database, namespace: string): StateStore & { seed(fixture: PyricStateFile): Promise<void> } {
  const connection = database.connection;
  function firestore() {
    const records = database.readRecords(namespace);
    const empty = records.size === 0;
    if (empty) return null;
    return JSON.parse(bundleRecords(records));
  }
  function auth() {
    const metadata = database.readRecord(namespace, 'meta');
    const parsed = z.object({ services: z.object({ auth: authSection.optional() }) }).safeParse(metadata);
    const validAuth = parsed.success;
    if (validAuth) return parsed.data.services.auth ?? null;
    return null;
  }
  function storage() {
    // length() comes from the row header, so this total reads no object bytes.
    const total = Number(connection.prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM storage_objects').get()?.total ?? 0);
    const exceedsExport = total > MAX_INLINE_EXPORT_STORAGE_BYTES;
    if (exceedsExport) throw new StateExportTooLargeError(total);
    return connection.prepare('SELECT metadata, mime, bytes FROM storage_objects ORDER BY bucket, path').all().map(row => {
      const bytes = row.bytes;
      const binary = bytes instanceof Uint8Array;
      const invalidBytes = !binary;
      if (invalidBytes) throw new Error('Invalid stored object bytes.');
      return { metadata: storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata'))), blobType: sqlText(row, 'mime'), dataBase64: Buffer.from(bytes).toString('base64') };
    });
  }
  function exists() {
    const hasRecords = database.hasRecords(namespace);
    const hasObjects = connection.prepare('SELECT 1 AS present FROM storage_objects LIMIT 1').get() !== undefined;
    return hasRecords || hasObjects;
  }
  function writeSection(section: StateSection, value: unknown, putBytes: PutStorageBytes): void {
    const isFirestore = section === 'firestore';
    if (isFirestore) {
      let records = new Map<string, unknown>();
      const hasValue = value !== null;
      if (hasValue) {
        records = parseBundle(JSON.stringify(value));
        decodeImportBundle(bundleRecords(records));
      }
      const removed = [...database.readRecords(namespace).keys()].filter(id => !records.has(id));
      database.commitChanges(namespace, records, removed);
      return;
    }
    const isAuth = section === 'auth';
    if (isAuth) {
      const hasValue = value !== null;
      let users: z.infer<typeof authSection>['users'] = [];
      if (hasValue) users = authSection.parse(value).users;
      const records = database.readRecords(namespace);
      let snapshot: ReturnType<typeof decodeImportBundle> = { firestore: {}, services: {} };
      const hasRecords = records.size > 0;
      if (hasRecords) snapshot = decodeImportBundle(bundleRecords(records));
      const previousAuth = z.object({ providers: z.record(z.boolean()) }).safeParse(snapshot.services.auth);
      let providers: Record<string, boolean> = {};
      const hasProviderConfiguration = previousAuth.success;
      if (hasProviderConfiguration) providers = previousAuth.data.providers;
      const next = serializeToBuckets(snapshot.firestore, { ...snapshot.services, auth: { users, providers } }, Date.now());
      database.commitChanges(namespace, next, []);
      return;
    }
    const objects = objectRecords.parse(value);
    database.commit(() => {
      for (const object of objects) {
        const tooLarge = object.metadata.size > MAX_STORAGE_OP_BYTES;
        if (tooLarge) throw storagePayloadTooLarge(object.metadata.size, 'Seed Storage object');
        const bytes = Buffer.from(object.dataBase64, 'base64');
        const invalidBase64 = bytes.toString('base64') !== object.dataBase64;
        if (invalidBase64) throw new Error('Seed Storage bytes are not canonical base64.');
        const wrongSize = bytes.length !== object.metadata.size;
        if (wrongSize) throw new Error('Seed Storage bytes do not match metadata size.');
        putBytes(object.metadata.fullPath, bytes, object.blobType, object.metadata);
      }
    });
  }
  return {
    projectDir,
    path: join(directory, 'state.sqlite'),
    backupPath: `${directory}.archive`,
    exists,
    load(): PyricStateFile | null {
      const hasState = exists();
      const empty = !hasState;
      if (empty) return null;
      return inTransaction(connection, () => ({ version: 1, firestore: firestore(), auth: auth(), storage: storage() }), 'read');
    },
    readSection(section) {
      const isFirestore = section === 'firestore';
      if (isFirestore) return firestore();
      const isAuth = section === 'auth';
      if (isAuth) return auth();
      return storage();
    },
    writeSection(section, value) {
      return database.storage.mutate(putBytes => writeSection(section, value, putBytes));
    },
    seed(fixture) {
      return database.storage.mutate(putBytes => {
        const hasFirestore = fixture.firestore != null;
        if (hasFirestore) writeSection('firestore', fixture.firestore, putBytes);
        const hasAuth = fixture.auth != null;
        if (hasAuth) writeSection('auth', fixture.auth, putBytes);
        const hasStorage = fixture.storage !== undefined;
        if (hasStorage) writeSection('storage', fixture.storage, putBytes);
        validateHostedDatabase(database);
      });
    },
  };
}
