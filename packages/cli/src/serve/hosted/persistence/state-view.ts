import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../../worker/protocol/storage.js';
import { bundleRecords, parseBundle, serializeToBuckets } from 'pyric/sandbox';
import { decodeImportBundle, seedUserSchema, storedMetadataSchema } from 'pyric/sandbox/internal';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isStorageReference, objectFileIn, parseStateFile, StateFileError, type StorageStateEntry } from '../../state-file.js';
import type { StateStore, PyricStateFile, StateSection } from '../../state-store.js';
import type { openHostedDatabase } from './database.js';
import { inTransaction } from './sqlite.js';
import type { StorageWrites } from './storage.js';
import { FILE_BYTES_SCHEMA_VERSION, storedObjects } from './stored-objects.js';
import { validateHostedDatabase } from './validate.js';

type Database = Awaited<ReturnType<typeof openHostedDatabase>>;
const authSection = z.object({ users: z.array(seedUserSchema) });
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The Storage entries a document carries, validated as a seed's are. */
function storageEntries(value: unknown): StorageStateEntry[] {
  return parseStateFile({ version: 1, storage: value }, 'Storage section').storage ?? [];
}

/**
 * Portable JSON is an explicit view of SQLite, never a second working store.
 * Its Storage entries refer to object files by hash; `objectFile` says where
 * each one is.
 */
export function createHostedStateView(projectDir: string, directory: string, database: Database, namespace: string): StateStore & { seed(fixture: PyricStateFile, objectsFrom?: string): Promise<void> } {
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
  function storage(): StorageStateEntry[] {
    const stored = storedObjects(connection, database.objects, database.schemaVersion());
    return stored.rows().map((row): StorageStateEntry => {
      const metadata = storedMetadataSchema.parse(JSON.parse(row.metadata));
      const sha256 = row.sha256;
      const inFile = sha256 !== undefined;
      if (inFile) return { path: row.path, sha256, size: row.size, blobType: row.mime, metadata };
      // A store an earlier release wrote, read without upgrading it, still holds its bytes inline.
      return { dataBase64: Buffer.from(stored.bytes(row)).toString('base64'), blobType: row.mime, metadata };
    });
  }
  function exists() {
    const hasRecords = database.hasRecords(namespace);
    const hasObjects = connection.prepare('SELECT 1 AS present FROM storage_objects LIMIT 1').get() !== undefined;
    return hasRecords || hasObjects;
  }
  function writeSection(section: StateSection, value: unknown, writes: StorageWrites, objectsFrom?: string): void {
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
    const objects = storageEntries(value);
    database.commit(() => {
      for (const object of objects) {
        const referenced = isStorageReference(object);
        if (referenced) {
          const from = objectsFrom;
          const unresolvable = from === undefined;
          if (unresolvable) throw new StateFileError(`Storage object '${object.path}' is a reference, and no directory holds its bytes.`);
          const file = objectFileIn(from, object.sha256);
          const missing = !existsSync(file);
          if (missing) throw new StateFileError(`Storage object '${object.path}' refers to ${file}, which does not exist.`);
          // The copy is checked against the hash before its row is written.
          writes.file(object.path, file, { sha256: object.sha256, size: object.size }, object.blobType, object.metadata);
          continue;
        }
        const tooLarge = object.metadata.size > MAX_STORAGE_OP_BYTES;
        if (tooLarge) throw storagePayloadTooLarge(object.metadata.size, 'Seed Storage object');
        const bytes = Buffer.from(object.dataBase64, 'base64');
        const invalidBase64 = bytes.toString('base64') !== object.dataBase64;
        if (invalidBase64) throw new Error('Seed Storage bytes are not canonical base64.');
        const wrongSize = bytes.length !== object.metadata.size;
        if (wrongSize) throw new Error('Seed Storage bytes do not match metadata size.');
        writes.bytes(object.metadata.fullPath, bytes, object.blobType, object.metadata);
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
      return database.storage.mutate(writes => writeSection(section, value, writes));
    },
    objectFile(sha256) {
      const inFiles = database.schemaVersion() >= FILE_BYTES_SCHEMA_VERSION && SHA256_HEX.test(sha256);
      const unavailable = !inFiles || database.objects.size(sha256) === undefined;
      if (unavailable) return undefined;
      return database.objects.path(sha256);
    },
    /** Seed from a document; its references resolve against `objectsFrom`. */
    seed(fixture, objectsFrom) {
      return database.storage.mutate(writes => {
        const hasFirestore = fixture.firestore != null;
        if (hasFirestore) writeSection('firestore', fixture.firestore, writes);
        const hasAuth = fixture.auth != null;
        if (hasAuth) writeSection('auth', fixture.auth, writes);
        const hasStorage = fixture.storage !== undefined;
        if (hasStorage) writeSection('storage', fixture.storage, writes, objectsFrom);
        validateHostedDatabase(database);
      });
    },
  };
}
