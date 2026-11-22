/**
 * Explicit partial recovery for an offline in-process state directory
 * (`in-process.json` and optional `storage.json` sidecar).
 *
 * Reads the source files without modifying them, validates every salvaged
 * record in memory before creating `--out`, and writes `in-process.json`,
 * optional `storage.json`, and `recovery-report.json` to the new directory.
 */
import 'fake-indexeddb/auto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  bundleRecords,
  initializeSandbox,
  parseBundle,
  serializeToBuckets,
} from 'pyric/sandbox';
import {
  CHUNK_FORMAT_VERSION,
  UnsupportedPersistedServiceError,
  checksumDocs,
  decodeImportBundle,
  deserializeRtdbRecords,
  isRtdbRecordId,
  persistedServiceHasData,
  validatePersistedService,
  validatePersistenceEncoding,
  validateRtdbImportRecord,
} from 'pyric/sandbox/internal';
import {
  DEFAULT_FIRESTORE_DATABASE,
  firestoreRecordSpaceKey,
  isValidFirestoreDatabaseId,
  readFirestoreDeclaredFromMeta,
  serializeNamedFirestoreDocsToBuckets,
  stampFirestoreDeclaredOnMeta,
} from 'pyric/firestore/internal';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { claimProjectState } from '../../serve/hosted/project-ownership.js';
import type { RecoveryReport } from '../../serve/hosted/persistence/salvage.js';
import { restoreStorage, type StorageObjectRecord } from '../surface/storage-state.js';
import type { ProjectStateOwner } from './in-process-persistence.js';
import { validateCliService } from './in-process-salvage-services.js';
import { salvageStorageSidecar } from './in-process-salvage-storage.js';

const V3_BUNDLE_FORMAT = 'pyric-v3-records';

const metadataShape = z.object({
  version: z.literal(CHUNK_FORMAT_VERSION),
  services: z.record(z.unknown()),
  firestoreDeclared: z.unknown().optional(),
});

const bucketShape = z.object({
  docs: z.record(z.unknown()),
  encoding: z.string().optional(),
  checksum: z.number().optional(),
});

const emptyMeta = { version: CHUNK_FORMAT_VERSION, savedAt: 0, services: {} };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  const same = rel === '';
  const outside = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
  return same || !outside;
}

interface BucketSalvageTarget {
  namespace: string;
  documents: Record<string, Record<string, unknown>>;
  duplicatePaths: Set<string>;
  report: RecoveryReport;
}

function salvageBucketRecord(id: string, value: unknown, target: BucketSalvageTarget): void {
  const bucket = bucketShape.safeParse(value);
  if (!bucket.success) {
    target.report.excluded.push({
      namespace: target.namespace,
      id,
      reason: 'Invalid document bucket',
    });
    return;
  }
  validatePersistenceEncoding(bucket.data.encoding);
  if (
    bucket.data.checksum !== undefined &&
    checksumDocs(bucket.data.docs) !== bucket.data.checksum
  ) {
    target.report.excluded.push({
      namespace: target.namespace,
      id,
      reason: 'Bucket checksum mismatch',
    });
    return;
  }
  for (const [path, docData] of Object.entries(bucket.data.docs)) {
    try {
      const singleRecord = { docs: { [path]: docData }, encoding: bucket.data.encoding };
      const decoded = decodeImportBundle(
        bundleRecords(new Map<string, unknown>([['meta', emptyMeta], [id, singleRecord]])),
      );
      if (target.duplicatePaths.has(path)) continue;
      if (Object.hasOwn(target.documents, path)) {
        delete target.documents[path];
        target.report.recoveredDocuments--;
        target.duplicatePaths.add(path);
        target.report.excluded.push({
          namespace: target.namespace,
          id: path,
          reason: 'Duplicate document path; all versions excluded',
        });
        continue;
      }
      target.documents[path] = decoded.firestore[path];
      target.report.recoveredDocuments++;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      target.report.excluded.push({
        namespace: target.namespace,
        id: path,
        reason: 'Document validation failed',
      });
    }
  }
}

function parseSourceRecords(raw: string): {
  parsedTop: unknown;
  records: Map<string, unknown>;
} {
  let parsedTop: unknown;
  try {
    parsedTop = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(
      'In-process state file is not valid JSON; recovery cannot establish the payload format.',
    );
  }
  if (isPlainRecord(parsedTop) && parsedTop.format === V3_BUNDLE_FORMAT) {
    if (!isPlainRecord(parsedTop.records)) {
      throw new Error(
        'Malformed in-process bundle records; recovery cannot establish the payload format.',
      );
    }
    return { parsedTop, records: new Map(Object.entries(parsedTop.records)) };
  }
  const migrated = parseBundle(raw);
  if (migrated.size === 0) {
    throw new Error('Unsupported or malformed in-process state format; recovery was not attempted.');
  }
  return { parsedTop, records: migrated };
}

function salvageNamedDatabases(
  parsedTop: unknown,
  report: RecoveryReport,
): Map<string, Record<string, Record<string, unknown>>> {
  const namedDocuments = new Map<string, Record<string, Record<string, unknown>>>();
  if (!isPlainRecord(parsedTop) || !Object.hasOwn(parsedTop, 'firestoreDatabases')) {
    return namedDocuments;
  }
  const rawDatabases = parsedTop.firestoreDatabases;
  if (rawDatabases === undefined) return namedDocuments;
  if (!isPlainRecord(rawDatabases)) {
    report.excluded.push({
      namespace: 'in-process',
      id: 'firestoreDatabases',
      reason: 'Named Firestore databases section must be an object',
    });
    return namedDocuments;
  }
  for (const [dbId, rawDbRecords] of Object.entries(rawDatabases)) {
    const namespace = firestoreRecordSpaceKey('in-process', dbId);
    if (dbId === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(dbId)) {
      report.excluded.push({ namespace: 'in-process', id: dbId, reason: 'Invalid Firestore database id' });
      continue;
    }
    if (!isPlainRecord(rawDbRecords)) {
      report.excluded.push({ namespace, id: dbId, reason: 'Invalid named database record map' });
      continue;
    }
    const dbDocs: Record<string, Record<string, unknown>> = {};
    const dbDuplicates = new Set<string>();
    for (const id of Object.keys(rawDbRecords).sort()) {
      if (id === 'meta' || isRtdbRecordId(id)) {
        report.excluded.push({
          namespace,
          id,
          reason: 'Unexpected metadata or RTDB record in named Firestore namespace',
        });
        continue;
      }
      salvageBucketRecord(id, rawDbRecords[id], {
        namespace,
        documents: dbDocs,
        duplicatePaths: dbDuplicates,
        report,
      });
    }
    if (Object.keys(dbDocs).length > 0) {
      namedDocuments.set(dbId, dbDocs);
    }
  }
  return namedDocuments;
}

export async function salvageInProcessState(
  sourceInput: string,
  outputInput: string,
): Promise<RecoveryReport> {
  const rawSourceStat = lstatSync(resolve(sourceInput), { throwIfNoEntry: false });
  if (rawSourceStat?.isSymbolicLink()) {
    throw new Error('Recovery source must not be a symlink.');
  }
  const resolvedSource = realpathSync(sourceInput);
  const outputParent = realpathSync(dirname(resolve(outputInput)));
  const output = resolve(outputParent, basename(outputInput));
  if (lstatSync(output, { throwIfNoEntry: false }) !== undefined || existsSync(output)) {
    throw new Error('Recovery output already exists; choose a new directory.');
  }
  const sourceStat = lstatSync(resolvedSource);
  let sourceDir: string;
  let snapshotPath: string;
  if (sourceStat.isFile()) {
    sourceDir = dirname(resolvedSource);
    snapshotPath = resolvedSource;
  } else if (sourceStat.isDirectory()) {
    sourceDir = resolvedSource;
    snapshotPath = join(sourceDir, 'in-process.json');
  } else {
    throw new Error('Recovery source must be an in-process state directory or in-process.json file.');
  }
  if (contains(sourceDir, output) || contains(output, sourceDir)) {
    throw new Error('Recovery output must be separate from the source directory.');
  }
  const sidecarPath = join(sourceDir, 'storage.json');
  const snapshotStat = lstatSync(snapshotPath, { throwIfNoEntry: false });
  if (snapshotStat !== undefined && !snapshotStat.isFile()) {
    throw new Error('Recovery source state files must be regular files, not symlinks or directories.');
  }
  const sidecarStat = lstatSync(sidecarPath, { throwIfNoEntry: false });
  if (sidecarStat !== undefined && !sidecarStat.isFile()) {
    throw new Error('Recovery source state files must be regular files, not symlinks or directories.');
  }
  const hasSnapshotFile = snapshotStat !== undefined;
  const hasSidecarFile = sidecarStat !== undefined;
  if (!hasSnapshotFile && !hasSidecarFile) {
    throw new Error('No in-process state files (in-process.json or storage.json) found in recovery source.');
  }

  const inProjectState =
    basename(sourceDir) === 'state' && basename(dirname(sourceDir)) === '.pyric';
  let owner: ProjectStateOwner | undefined;
  if (inProjectState) {
    owner = await claimProjectState(dirname(dirname(sourceDir)), 'in-process');
  }

  try {
    const report: RecoveryReport = {
      recoveredDocuments: 0,
      recoveredServices: 0,
      recoveredObjects: 0,
      recoveredCheckpoints: 0,
      repairedObjects: [],
      excluded: [],
      quarantined: [],
    };
    const documents: Record<string, Record<string, unknown>> = {};
    const duplicatePaths = new Set<string>();
    const services: Record<string, unknown> = {};
    const salvagedRtdbRecords: Array<[string, unknown]> = [];
    let recoveredDeclared: string[] = [];
    let namedDocuments = new Map<string, Record<string, Record<string, unknown>>>();

    if (hasSnapshotFile) {
      const { parsedTop, records } = parseSourceRecords(readFileSync(snapshotPath, 'utf8'));
      if (records.size > 0 && !records.has('meta')) {
        throw new Error('Missing in-process metadata; recovery cannot establish the payload format.');
      }
      if (records.has('meta')) {
        const metadata = metadataShape.safeParse(records.get('meta'));
        if (!metadata.success) {
          throw new Error(
            'Unsupported or malformed metadata; recovery cannot establish the payload format.',
          );
        }
        if (metadata.data.firestoreDeclared !== undefined) {
          try {
            recoveredDeclared = readFirestoreDeclaredFromMeta({
              firestoreDeclared: metadata.data.firestoreDeclared,
            });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            report.excluded.push({
              namespace: 'in-process',
              id: 'firestoreDeclared',
              reason: 'Named Firestore declaration list validation failed',
            });
          }
        }
        for (const [name, data] of Object.entries(metadata.data.services)) {
          if (name === 'rtdb') {
            report.excluded.push({
              namespace: 'services',
              id: name,
              reason: 'Inline RTDB metadata service is unsupported',
            });
            continue;
          }
          try {
            const cliService = validateCliService(name, data);
            if (cliService.handled) {
              services[name] = data;
              if (cliService.hasData) report.recoveredServices++;
              continue;
            }
            validatePersistedService(name, data);
            services[name] = data;
            if (persistedServiceHasData(name, data)) report.recoveredServices++;
          } catch (error) {
            if (error instanceof UnsupportedPersistedServiceError) throw error;
            report.excluded.push({
              namespace: 'services',
              id: name,
              reason: 'Service validation failed',
            });
          }
        }
      }
      for (const id of [...records.keys()].sort()) {
        if (id === 'meta') continue;
        const value = records.get(id);
        if (isRtdbRecordId(id)) {
          try {
            validateRtdbImportRecord(id, value);
            salvagedRtdbRecords.push([id, value]);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            report.excluded.push({
              namespace: 'in-process',
              id,
              reason: 'RTDB record integrity or value validation failed',
            });
          }
          continue;
        }
        salvageBucketRecord(id, value, {
          namespace: 'in-process',
          documents,
          duplicatePaths,
          report,
        });
      }
      if (salvagedRtdbRecords.length > 0) {
        const rtdbState = deserializeRtdbRecords(salvagedRtdbRecords);
        if (rtdbState !== undefined) {
          try {
            validatePersistedService('rtdb', rtdbState);
            services.rtdb = rtdbState;
            if (persistedServiceHasData('rtdb', rtdbState)) {
              report.recoveredServices++;
            }
          } catch (error) {
            if (error instanceof UnsupportedPersistedServiceError) throw error;
            report.excluded.push({
              namespace: 'services',
              id: 'rtdb',
              reason: 'Service validation failed',
            });
          }
        }
      }
      namedDocuments = salvageNamedDatabases(parsedTop, report);
    }

    let salvagedStorageRecords: StorageObjectRecord[] = [];
    if (hasSidecarFile) {
      salvagedStorageRecords = await salvageStorageSidecar(sidecarPath, hasSnapshotFile, report);
    }

    const emptyRecovery =
      report.recoveredDocuments +
        report.recoveredServices +
        report.recoveredObjects +
        report.recoveredCheckpoints +
        recoveredDeclared.length ===
      0;
    if (emptyRecovery) {
      throw new Error('No recoverable state was found; no empty replacement was produced.');
    }

    let outBundleJson: string | undefined;
    if (hasSnapshotFile) {
      const outRecords: Map<string, unknown> = serializeToBuckets(documents, services, Date.now());
      if (recoveredDeclared.length > 0 && outRecords.has('meta')) {
        outRecords.set(
          'meta',
          stampFirestoreDeclaredOnMeta(
            outRecords.get('meta') as Record<string, unknown>,
            recoveredDeclared,
          ),
        );
      }
      const rawBundle = JSON.parse(bundleRecords(outRecords)) as Record<string, unknown>;
      if (namedDocuments.size > 0) {
        const serializedNamed: Record<string, Record<string, unknown>> = {};
        for (const [dbId, dbDocs] of namedDocuments) {
          const dbBuckets = serializeNamedFirestoreDocsToBuckets(dbDocs);
          serializedNamed[dbId] = Object.fromEntries(dbBuckets);
        }
        rawBundle.firestoreDatabases = serializedNamed;
      }
      outBundleJson = JSON.stringify(rawBundle);
      const verified = decodeImportBundle(outBundleJson);
      for (const [name, data] of Object.entries(verified.services)) {
        const cliService = validateCliService(name, data);
        if (!cliService.handled) validatePersistedService(name, data);
      }
      const verifySandbox = initializeSandbox();
      verifySandbox.loadSnapshot(verified);
    }
    if (salvagedStorageRecords.length > 0) {
      const verifyStorageSandbox = initializeSandbox();
      await restoreStorage(getAdminStorageSandbox(verifyStorageSandbox), salvagedStorageRecords);
    }

    mkdirSync(output);
    if (outBundleJson !== undefined) {
      writeFileSync(join(output, 'in-process.json'), outBundleJson, 'utf8');
    }
    if (salvagedStorageRecords.length > 0) {
      writeFileSync(
        join(output, 'storage.json'),
        `${JSON.stringify(salvagedStorageRecords, null, 2)}\n`,
        'utf8',
      );
    }
    writeFileSync(join(output, 'recovery-report.json'), JSON.stringify(report, null, 2), 'utf8');
    return report;
  } finally {
    if (owner !== undefined) owner.close();
  }
}
