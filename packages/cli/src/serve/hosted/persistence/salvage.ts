import { salvageHistory } from './history-salvage.js';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { bundleRecords, serializeToBuckets } from 'pyric/sandbox';
import { decodeImportBundle, validatePersistenceEncoding, storedMetadataSchema, validatePersistedService, persistedServiceHasData, UnsupportedPersistedServiceError } from 'pyric/sandbox/internal';
import { claimProjectState } from '../project-ownership.js';
import { openHostedDatabase, HOSTED_SCHEMA_VERSION } from './database.js';
import { openNodeSqlite, sqlText } from './sqlite.js';
import { validateHostedDatabase } from './validate.js';

export interface RecoveryReport {
  recoveredDocuments: number;
  recoveredServices: number;
  recoveredObjects: number;
  recoveredHistory: number;
  excluded: Array<{ namespace: string; id: string; reason: string }>;
}

const metadataShape = z.object({ version: z.literal(3), services: z.record(z.unknown()) });
const bucketShape = z.object({ docs: z.record(z.unknown()), encoding: z.string().optional(), checksum: z.number().optional() });
const emptyMeta = { version: 3, savedAt: 0, services: {} };

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const same = path === '';
  const outside = isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
  return same || !outside;
}

/** Explicit partial recovery on a disposable copy; never writes to the source. */
export async function salvageHostedState(sourceInput: string, outputInput: string): Promise<RecoveryReport> {
  const source = realpathSync(sourceInput);
  const output = resolve(realpathSync(dirname(outputInput)), basename(outputInput));
  const outputExists = existsSync(output);
  if (outputExists) throw new Error('Recovery output already exists; choose a new directory.');
  const overlaps = contains(source, output) || contains(output, source);
  if (overlaps) throw new Error('Recovery output must be separate from the source directory.');
  for (const name of readdirSync(source)) {
    const regular = lstatSync(join(source, name)).isFile();
    const unsafeEntry = !regular;
    if (unsafeEntry) throw new Error('Recovery source must contain regular files, not symlinks or directories.');
  }
  // Standard active/archived directories share their project's ownership file.
  const inProjectState = basename(dirname(source)) === 'state' && basename(dirname(dirname(source))) === '.pyric';
  const owner = inProjectState ? await claimProjectState(dirname(dirname(dirname(source)))) : undefined;
  let scratch: string | undefined;
  let outputCreated = false;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'pyric-salvage-'));
    const copy = join(scratch, 'source');
    cpSync(source, copy, { recursive: true });
    const input = await openNodeSqlite(join(copy, 'state.sqlite'), true);
    try {
      const version = input.prepare('PRAGMA user_version').get()?.user_version;
      const unsupported = version !== HOSTED_SCHEMA_VERSION;
      if (unsupported) throw new Error(`Unsupported hosted database version ${String(version)}; recovery was not attempted.`);
      const corrupt = input.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok');
      if (corrupt) throw new Error('Physical SQLite corruption prevents this recovery. The original directory is unchanged.');
      const report: RecoveryReport = { recoveredDocuments: 0, recoveredServices: 0, recoveredObjects: 0, recoveredHistory: 0, excluded: [] };
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
        const objects = input.prepare('SELECT bucket, path, metadata, mime, bytes FROM storage_objects ORDER BY bucket, path').all();
        for (const row of objects) {
          const id = `${sqlText(row, 'bucket')}/${sqlText(row, 'path')}`;
          try {
            const metadata = storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata')));
            const bytes = row.bytes;
            const binary = bytes instanceof Uint8Array;
            const invalidBytes = !binary;
            if (invalidBytes) throw new Error('Invalid bytes');
            const mismatchedBucket = metadata.bucket !== row.bucket;
            if (mismatchedBucket) throw new Error('Invalid bucket');
            await recovered.storage.put(sqlText(row, 'path'), new Blob([Uint8Array.from(bytes)], { type: sqlText(row, 'mime') }), metadata);
            report.recoveredObjects++;
          } catch { report.excluded.push({ namespace: 'storage', id, reason: 'Object validation failed' }); }
        }
        const emptyRecovery = report.recoveredDocuments + report.recoveredServices + report.recoveredObjects === 0;
        if (emptyRecovery) throw new Error('No recoverable state was found; no empty replacement was produced.');
        const records = serializeToBuckets(documents, services, Date.now());
        const decoded = decodeImportBundle(bundleRecords(records));
        for (const [name, data] of Object.entries(decoded.services)) validatePersistedService(name, data);
        await recovered.records.putRecords('hosted', records);
        salvageHistory(input, recovered, report);
        validateHostedDatabase(recovered);
        recovered.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { recovered.close(); }
      const reopened = await openHostedDatabase(output, { readOnly: true });
      try { validateHostedDatabase(reopened); } finally { reopened.close(); }
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
