import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { bundleRecords, serializeToBuckets } from 'pyric/sandbox';
import { decodeImportBundle, validatePersistenceEncoding, storedMetadataSchema, validatePersistedService, persistedServiceHasData, UnsupportedPersistedServiceError } from 'pyric/sandbox/internal';
import { claimProjectState } from '../project-ownership.js';
import { createBlobStore } from './blob-store.js';
import { openHostedDatabase, READABLE_HOSTED_SCHEMA_VERSIONS } from './database.js';
import { openNodeSqlite, sqlText } from './sqlite.js';
import { storedObjects } from './stored-objects.js';
import { repairedStorageMetadata, validateHostedDatabase, type StorageMetadataRepair } from './validate.js';

export interface RecoveryReport {
  recoveredDocuments: number;
  recoveredServices: number;
  recoveredObjects: number;
  repairedObjects: StorageMetadataRepair[];
  excluded: Array<{ namespace: string; id: string; reason: string }>;
  /** Object files whose content does not match their hash, copied to `file` in the output. */
  quarantined: Array<{ bucket: string; path: string; sha256: string; file: string }>;
}

const QUARANTINE_REASON = 'Object bytes do not match their hash; the file was copied to quarantine';

const metadataShape = z.object({ version: z.literal(3), services: z.record(z.unknown()) });
const bucketShape = z.object({ docs: z.record(z.unknown()), encoding: z.string().optional(), checksum: z.number().optional() });
const emptyMeta = { version: 3, savedAt: 0, services: {} };

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const same = path === '';
  const outside = isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
  return same || !outside;
}

/** The object directory may nest directories, and nothing in it may be a link. */
function assertRegularTree(directory: string): void {
  for (const name of readdirSync(directory)) {
    const entry = lstatSync(join(directory, name));
    const nested = entry.isDirectory();
    if (nested) { assertRegularTree(join(directory, name)); continue; }
    const regular = entry.isFile();
    const unsafeEntry = !regular;
    if (unsafeEntry) throw new Error('Recovery source objects must be regular files, not symlinks.');
  }
}

/**
 * Explicit partial recovery on a disposable copy of the database; never writes
 * to the source. Object files are read in place, since they are never modified.
 */
export async function salvageHostedState(sourceInput: string, outputInput: string): Promise<RecoveryReport> {
  const source = realpathSync(sourceInput);
  const output = resolve(realpathSync(dirname(outputInput)), basename(outputInput));
  const outputExists = existsSync(output);
  if (outputExists) throw new Error('Recovery output already exists; choose a new directory.');
  const overlaps = contains(source, output) || contains(output, source);
  if (overlaps) throw new Error('Recovery output must be separate from the source directory.');
  const objectsDirectory = join(source, 'objects');
  for (const name of readdirSync(source)) {
    const entry = lstatSync(join(source, name));
    const holdsObjects = name === 'objects' && entry.isDirectory();
    if (holdsObjects) { assertRegularTree(objectsDirectory); continue; }
    const regular = entry.isFile();
    const unsafeEntry = !regular;
    if (unsafeEntry) throw new Error('Recovery source must contain regular files and an objects directory, not symlinks or other directories.');
  }
  // Standard active/archived directories hold the Node host's state files.
  const inProjectState = basename(dirname(source)) === 'state' && basename(dirname(dirname(source))) === '.pyric';
  const owner = inProjectState ? await claimProjectState(dirname(dirname(dirname(source))), 'host') : undefined;
  let scratch: string | undefined;
  let outputCreated = false;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'pyric-salvage-'));
    const copy = join(scratch, 'source');
    cpSync(source, copy, { recursive: true, filter: path => path !== objectsDirectory });
    const input = await openNodeSqlite(join(copy, 'state.sqlite'), true);
    try {
      const version = input.prepare('PRAGMA user_version').get()?.user_version;
      const unsupported = !READABLE_HOSTED_SCHEMA_VERSIONS.has(Number(version));
      if (unsupported) throw new Error(`Unsupported hosted database version ${String(version)}; recovery was not attempted.`);
      const corrupt = input.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok');
      if (corrupt) throw new Error('Physical SQLite corruption prevents this recovery. The original directory is unchanged.');
      const report: RecoveryReport = { recoveredDocuments: 0, recoveredServices: 0, recoveredObjects: 0, repairedObjects: [], excluded: [], quarantined: [] };
      const documents: Record<string, Record<string, unknown>> = {};
      const services: Record<string, unknown> = {};
      const duplicatePaths = new Set<string>();
      const rows = input.prepare('SELECT namespace, id, payload FROM records ORDER BY namespace, id').all();
      const hasMetadata = rows.some(row => row.namespace === 'hosted' && row.id === 'meta');
      const missingMetadata = !hasMetadata;
      if (missingMetadata) throw new Error('Missing hosted metadata; recovery cannot establish the payload format.');
      for (const row of rows) {
        const namespace = sqlText(row, 'namespace');
        const id = sqlText(row, 'id');
        const unknownNamespace = namespace !== 'hosted';
        if (unknownNamespace) throw new Error(`Unsupported persistence namespace '${namespace}'.`);
        let value: unknown;
        try { value = JSON.parse(sqlText(row, 'payload')); }
        catch {
          const isMetadata = id === 'meta';
          if (isMetadata) throw new Error('Malformed metadata; recovery cannot establish the payload format.');
          report.excluded.push({ namespace, id, reason: 'Invalid JSON' });
          continue;
        }
        const isMetadata = id === 'meta';
        if (isMetadata) {
          const metadata = metadataShape.safeParse(value);
          const invalidMetadata = !metadata.success;
          if (invalidMetadata) throw new Error('Unsupported or malformed metadata; recovery cannot establish the payload format.');
          for (const [name, data] of Object.entries(metadata.data.services)) {
            try {
              validatePersistedService(name, data);
              services[name] = data;
              const recoveredState = persistedServiceHasData(name, data);
              if (recoveredState) report.recoveredServices++;
            }
            catch (error) {
              const unsupported = error instanceof UnsupportedPersistedServiceError;
              if (unsupported) throw error;
              report.excluded.push({ namespace: 'services', id: name, reason: 'Service validation failed' });
            }
          }
          continue;
        }
        const bucket = bucketShape.safeParse(value);
        const invalidBucket = !bucket.success;
        if (invalidBucket) { report.excluded.push({ namespace, id, reason: 'Invalid document bucket' }); continue; }
        validatePersistenceEncoding(bucket.data.encoding);
        // A checksum mismatch cannot establish which bytes were corrupted.
        const checksummed = bucket.data.checksum !== undefined;
        if (checksummed) {
          try { decodeImportBundle(bundleRecords(new Map<string, unknown>([['meta', emptyMeta], [id, value]]))); }
          catch { report.excluded.push({ namespace, id, reason: 'Bucket integrity or value validation failed' }); continue; }
        }
        for (const [path, data] of Object.entries(bucket.data.docs)) {
          try {
            const record = { docs: { [path]: data }, encoding: bucket.data.encoding };
            const decoded = decodeImportBundle(bundleRecords(new Map<string, unknown>([['meta', emptyMeta], [id, record]])));
            const previouslyExcluded = duplicatePaths.has(path);
            if (previouslyExcluded) continue;
            const duplicate = Object.hasOwn(documents, path);
            if (duplicate) {
              delete documents[path];
              report.recoveredDocuments--;
              duplicatePaths.add(path);
              report.excluded.push({ namespace, id: path, reason: 'Duplicate document path; all versions excluded' });
              continue;
            }
            documents[path] = decoded.firestore[path];
            report.recoveredDocuments++;
          } catch { report.excluded.push({ namespace, id: path, reason: 'Document validation failed' }); }
        }
      }
      mkdirSync(output);
      outputCreated = true;
      const recovered = await openHostedDatabase(output);
      try {
        const sourceObjects = createBlobStore(objectsDirectory);
        const objects = storedObjects(input, sourceObjects, Number(version));
        for (const row of objects.rows()) {
          const id = `${row.bucket}/${row.path}`;
          try {
            const metadata = storedMetadataSchema.parse(JSON.parse(row.metadata));
            const mismatchedBucket = metadata.bucket !== row.bucket;
            if (mismatchedBucket) throw new Error('Invalid bucket');
            const sha256 = row.sha256;
            const inFile = sha256 !== undefined;
            let content: Uint8Array<ArrayBuffer>;
            if (inFile) {
              // A file is read whole whatever size its row records, and trusted
              // only if it still hashes to its name.
              const file = sourceObjects.path(sha256);
              content = readFileSync(file) as Uint8Array<ArrayBuffer>;
              const rotted = createHash('sha256').update(content).digest('hex') !== sha256;
              if (rotted) {
                mkdirSync(join(output, 'quarantine'), { recursive: true });
                copyFileSync(file, join(output, 'quarantine', sha256));
                report.quarantined.push({ bucket: row.bucket, path: row.path, sha256, file: `quarantine/${sha256}` });
                report.excluded.push({ namespace: 'storage', id, reason: QUARANTINE_REASON });
                continue;
              }
            } else {
              content = objects.bytes(row);
            }
            // The bytes are the object; a size they disagree with is repaired
            // rather than costing the object its place in the recovery.
            const wrongSize = metadata.size !== content.byteLength;
            const stored = wrongSize ? repairedStorageMetadata(metadata, content) : metadata;
            await recovered.storage.put(row.path, new Blob([content], { type: row.mime }), stored);
            report.recoveredObjects++;
            if (wrongSize) report.repairedObjects.push({ bucket: row.bucket, path: row.path, recordedSize: metadata.size, actualSize: content.byteLength });
          } catch { report.excluded.push({ namespace: 'storage', id, reason: 'Object validation failed' }); }
        }
        const emptyRecovery = report.recoveredDocuments + report.recoveredServices + report.recoveredObjects === 0;
        if (emptyRecovery) throw new Error('No recoverable state was found; no empty replacement was produced.');
        const records = serializeToBuckets(documents, services, Date.now());
        const decoded = decodeImportBundle(bundleRecords(records));
        for (const [name, data] of Object.entries(decoded.services)) validatePersistedService(name, data);
        await recovered.records.putRecords('hosted', records);
        validateHostedDatabase(recovered);
        recovered.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { recovered.close(); }
      writeFileSync(join(output, 'recovery-report.json'), JSON.stringify(report, null, 2));
      return report;
    } finally { input.close(); }
  } catch (error) {
    if (outputCreated) rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    const cleanupDirectory = scratch;
    const hasScratch = cleanupDirectory !== undefined;
    if (hasScratch) rmSync(cleanupDirectory, { recursive: true, force: true });
    owner?.close();
  }
}
