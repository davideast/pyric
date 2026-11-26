import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../../worker/protocol/storage.js';
import { bundleRecords, parseBundle, serializeToBuckets } from 'pyric/sandbox';
import {
  CHUNK_FORMAT_VERSION,
  decodeImportBundle,
  isRtdbRecordId,
  seedUserSchema,
  serializeRtdbServiceToRecords,
  storedMetadataSchema,
} from 'pyric/sandbox/internal';
import {
  DEFAULT_FIRESTORE_DATABASE,
  firestoreRecordSpaceKey,
  isValidFirestoreDatabaseId,
  readFirestoreDeclaredFromMeta,
  stampFirestoreDeclaredOnMeta,
} from 'pyric/firestore/internal';
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
const authSection = z.looseObject({ users: z.array(seedUserSchema) });
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The Storage entries a document carries, validated as a seed's are. */
function storageEntries(value: unknown): StorageStateEntry[] {
  const empty = value === null;
  if (empty) return [];
  return parseStateFile({ version: 1, storage: value }, 'Storage section').storage ?? [];
}

/**
 * Portable JSON is an explicit view of SQLite, never a second working store.
 * Its Storage entries refer to object files by hash; `objectFile` says where
 * each one is.
 */
export function createHostedStateView(projectDir: string, directory: string, database: Database, namespace: string): StateStore & { seed(fixture: PyricStateFile, objectsFrom?: string): Promise<void> } {
  const connection = database.connection;
  function listNamedSpaces(): string[] {
    if (typeof database.listNamedFirestoreDatabases === 'function') {
      return database.listNamedFirestoreDatabases(namespace);
    }
    return [];
  }
  function readNamedDatabases(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
    for (const dbId of listNamedSpaces()) {
      const dbRecords = database.readRecords(firestoreRecordSpaceKey(namespace, dbId));
      if (dbRecords.size === 0) continue;
      out[dbId] = Object.fromEntries(dbRecords);
    }
    return out;
  }
  function firestore() {
    const records = database.readRecords(namespace);
    const namedDatabases = readNamedDatabases();
    const hasNamed = Object.keys(namedDatabases).length > 0;
    const empty = records.size === 0 && !hasNamed;
    if (empty) return null;
    let parsed: Record<string, unknown>;
    if (records.size > 0) {
      parsed = JSON.parse(bundleRecords(records)) as Record<string, unknown>;
    } else {
      parsed = { format: 'pyric-v3-records', records: {} };
    }
    if (hasNamed) {
      parsed.firestoreDatabases = namedDatabases;
    }
    return parsed;
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
    let hasRecords: boolean;
    if (typeof database.hasAnyRecords === 'function') {
      hasRecords = database.hasAnyRecords(namespace);
    } else {
      hasRecords = database.hasRecords(namespace) || listNamedSpaces().length > 0;
    }
    const hasObjects = connection.prepare('SELECT 1 AS present FROM storage_objects LIMIT 1').get() !== undefined;
    return hasRecords || hasObjects;
  }
  function parseIncomingNamedDatabases(value: unknown): Map<string, Map<string, unknown>> {
    const out = new Map<string, Map<string, unknown>>();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return out;
    }
    if (!Object.hasOwn(value, 'firestoreDatabases')) {
      return out;
    }
    const rawMap = (value as { firestoreDatabases?: unknown }).firestoreDatabases;
    if (rawMap === undefined) {
      return out;
    }
    if (rawMap === null || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
      throw new Error('Invalid firestoreDatabases bundle section: expected an object.');
    }
    const syntheticMeta = { version: CHUNK_FORMAT_VERSION, savedAt: 0, services: {} };
    for (const [dbId, rawDbRecords] of Object.entries(rawMap as Record<string, unknown>)) {
      if (dbId === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(dbId)) {
        throw new Error(`Invalid Firestore database id '${dbId}' in firestoreDatabases.`);
      }
      if (rawDbRecords === null || typeof rawDbRecords !== 'object' || Array.isArray(rawDbRecords)) {
        throw new Error(`Invalid record map for Firestore database '${dbId}'.`);
      }
      const entries = new Map<string, unknown>(Object.entries(rawDbRecords as Record<string, unknown>));
      for (const recordId of entries.keys()) {
        if (recordId === 'meta' || isRtdbRecordId(recordId)) {
          throw new Error(`Invalid record '${recordId}' in firestoreDatabases['${dbId}'].`);
        }
      }
      if (entries.size > 0) {
        const checkRecords = new Map<string, unknown>([['meta', syntheticMeta], ...entries]);
        decodeImportBundle(bundleRecords(checkRecords));
      }
      out.set(dbId, entries);
    }
    return out;
  }
  function writeSection(section: StateSection, value: unknown, writes: StorageWrites, objectsFrom?: string): void {
    const isFirestore = section === 'firestore';
    if (isFirestore) {
      const existing = database.readRecords(namespace);
      const existingServices = existing.size > 0 ? decodeImportBundle(bundleRecords(existing)).services : {};
      const existingNamedIds = listNamedSpaces();
      let records = new Map<string, unknown>();
      let incomingNamed = new Map<string, Map<string, unknown>>();
      const hasValue = value !== null;
      if (hasValue) {
        incomingNamed = parseIncomingNamedDatabases(value);
        records = parseBundle(JSON.stringify(value));
        const incoming = decodeImportBundle(bundleRecords(records));
        const incomingDeclared = readFirestoreDeclaredFromMeta(records.get('meta'));
        const mergedServices = { ...existingServices, ...incoming.services };
        for (const id of [...records.keys()]) {
          if (isRtdbRecordId(id)) records.delete(id);
        }
        const metaServices = { ...mergedServices };
        if ('rtdb' in metaServices) {
          const rtdbRecords = serializeRtdbServiceToRecords(metaServices.rtdb);
          delete metaServices.rtdb;
          if (rtdbRecords !== null) {
            for (const [id, rec] of rtdbRecords) records.set(id, rec);
          }
        }
        const meta = (records.get('meta') as Record<string, unknown> | undefined) ?? {
          version: CHUNK_FORMAT_VERSION,
          savedAt: Date.now(),
          services: {},
        };
        records.set('meta', stampFirestoreDeclaredOnMeta({ ...meta, services: metaServices }, incomingDeclared));
      } else {
        const hasServices = Object.keys(existingServices).length > 0;
        if (hasServices) records = serializeToBuckets({}, existingServices, Date.now());
      }
      const removed = [...existing.keys()].filter(id => !records.has(id));
      database.commitChanges(namespace, records, removed);
      for (const [dbId, dbRecords] of incomingNamed) {
        const dbNs = firestoreRecordSpaceKey(namespace, dbId);
        const priorDb = database.readRecords(dbNs);
        const dbRemoved = [...priorDb.keys()].filter(id => !dbRecords.has(id));
        database.commitChanges(dbNs, dbRecords, dbRemoved);
      }
      for (const priorDbId of existingNamedIds) {
        if (!incomingNamed.has(priorDbId)) {
          const dbNs = firestoreRecordSpaceKey(namespace, priorDbId);
          const priorDb = database.readRecords(dbNs);
          database.commitChanges(dbNs, new Map(), [...priorDb.keys()]);
        }
      }
      return;
    }
    const isAuth = section === 'auth';
    if (isAuth) {
      const hasValue = value !== null;
      let users: z.infer<typeof authSection>['users'] = [];
      let incomingExtras: Record<string, unknown> = {};
      if (hasValue) {
        const parsedAuth = authSection.parse(value);
        const { users: parsedUsers, ...rest } = parsedAuth;
        users = parsedUsers;
        incomingExtras = rest;
      }
      const records = database.readRecords(namespace);
      const preservedDeclared = readFirestoreDeclaredFromMeta(records.get('meta'));
      let snapshot: ReturnType<typeof decodeImportBundle> = { firestore: {}, services: {} };
      const hasRecords = records.size > 0;
      if (hasRecords) snapshot = decodeImportBundle(bundleRecords(records));
      const clearsAuth = !hasValue;
      if (clearsAuth) {
        const { auth: _cleared, ...restServices } = snapshot.services;
        const hasNamedSpaces = listNamedSpaces().length > 0;
        const hasRemainingState =
          Object.keys(snapshot.firestore).length > 0 ||
          Object.keys(restServices).length > 0 ||
          preservedDeclared.length > 0 ||
          hasNamedSpaces;
        let next: Map<string, unknown> = new Map<string, unknown>();
        if (hasRemainingState) {
          next = serializeToBuckets(snapshot.firestore, restServices, Date.now());
        }
        if (next.has('meta') && preservedDeclared.length > 0) {
          next.set(
            'meta',
            stampFirestoreDeclaredOnMeta(next.get('meta') as Record<string, unknown>, preservedDeclared),
          );
        }
        const removed = [...records.keys()].filter(id => !next.has(id));
        database.commitChanges(namespace, next, removed);
        return;
      }
      const existingAuth =
        snapshot.services.auth !== null &&
        typeof snapshot.services.auth === 'object' &&
        !Array.isArray(snapshot.services.auth)
          ? (snapshot.services.auth as Record<string, unknown>)
          : {};
      const incomingProviders = z.record(z.string(), z.boolean()).safeParse(incomingExtras.providers);
      const previousProviders = z.record(z.string(), z.boolean()).safeParse(existingAuth.providers);
      let providers: Record<string, boolean> = {};
      if (incomingProviders.success) {
        providers = incomingProviders.data;
      } else if (previousProviders.success) {
        providers = previousProviders.data;
      }
      const nextAuth = {
        ...existingAuth,
        ...incomingExtras,
        users,
        providers,
      };
      const next: Map<string, unknown> = serializeToBuckets(
        snapshot.firestore,
        { ...snapshot.services, auth: nextAuth },
        Date.now(),
      );
      if (next.has('meta') && preservedDeclared.length > 0) {
        next.set(
          'meta',
          stampFirestoreDeclaredOnMeta(next.get('meta') as Record<string, unknown>, preservedDeclared),
        );
      }
      const removed = [...records.keys()].filter(id => !next.has(id));
      database.commitChanges(namespace, next, removed);
      return;
    }
    const objects = storageEntries(value);
    database.commit(() => {
      connection.exec('DELETE FROM storage_objects');
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
