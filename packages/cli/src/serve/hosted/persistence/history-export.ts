import { opendir } from 'node:fs/promises';
import { historyRecordSchema, decodeHistoryRecord } from './history-record.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { openNodeSqlite } from './sqlite.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostedHistory, HistoryQuery, HistoryRecord } from './history.js';
const ARCHIVE_FORMAT = 'pyric/history/1';
const headerSchema = z.object({ format: z.literal(ARCHIVE_FORMAT), storeId: z.string().uuid(), after: z.number().int().nonnegative(), previous: z.string().nullable() });
const footerSchema = z.object({ through: z.number().int().nonnegative(), count: z.number().int().positive(), checksum: z.string() });
const checkpointSchema = z.object({ storeId: z.string().uuid(), sequence: z.number().int().nonnegative(), file: z.string() });
export interface HistorySource {
  status(): ReturnType<HostedHistory['status']> | Promise<ReturnType<HostedHistory['status']>>;
  list(query: HistoryQuery): ReturnType<HostedHistory['list']> | Promise<ReturnType<HostedHistory['list']>>;
  flush(): void | Promise<void>;
}
function syncDirectory(directory: string): void {
  const handle = openSync(directory, 'r');
  try {
    fsyncSync(handle);
  }
  finally {
    closeSync(handle);
  }
}
function writeAll(handle: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  let hasBytes = offset < bytes.length;
  while (hasBytes) {
    offset += writeSync(handle, bytes, offset, bytes.length - offset);
    hasBytes = offset < bytes.length;
  }
}
function checkpoint(directory: string, value: z.infer<typeof checkpointSchema>): void {
  const temporary = join(directory, `.checkpoint-${randomUUID()}.tmp`);
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    writeAll(handle, JSON.stringify(value));
    fsyncSync(handle);
  }
  finally {
    closeSync(handle);
  }
  renameSync(temporary, join(directory, 'checkpoint.json'));
  syncDirectory(directory);
}
/** Verify complete lines and the segment checksum without retaining the archive. */
export async function verifyHistorySegment(path: string) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const hash = createHash('sha256');
  let header: z.infer<typeof headerSchema> | undefined;
  let footer: z.infer<typeof footerSchema> | undefined;
  let through = 0;
  let count = 0;
  try {
    for await (const line of lines) {
      const value: unknown = JSON.parse(line);
      const needsHeader = header === undefined;
      if (needsHeader) {
        header = headerSchema.parse(value);
        through = header.after;
        hash.update(`${line}\n`);
        continue;
      }
      const alreadyEnded = footer !== undefined;
      if (alreadyEnded)
        throw new Error(`Unexpected bytes after archive footer: ${path}`);
      const ending = footerSchema.safeParse(value);
      const isFooter = ending.success;
      if (isFooter) {
        footer = ending.data;
        continue;
      }
      const record = historyRecordSchema.parse(value);
      const contiguous = record.sequence === through + 1;
      const hasGap = !contiguous;
      if (hasGap)
        throw new Error(`History gap before sequence ${record.sequence}: ${path}`);
      decodeHistoryRecord(record);
      hash.update(`${line}\n`);
      through = record.sequence;
      count++;
    }
    const validFooter = footer?.through === through && footer?.count === count && footer?.checksum === hash.digest('hex');
    const verifiedHeader = header;
    const missingHeader = verifiedHeader === undefined;
    if (missingHeader)
      throw new Error(`Missing history archive header: ${path}`);
    const invalidFooter = !validFooter;
    if (invalidFooter)
      throw new Error(`Incomplete or corrupt history archive: ${path}`);
    return { storeId: verifiedHeader.storeId, after: verifiedHeader.after, previous: verifiedHeader.previous, through, count };
  }
  finally {
    lines.close();
    input.destroy();
  }
}
async function archiveFiles(directory: string) {
  let latest: string | null = null;
  let storeId: string | null = null;
  let count = 0;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const isArchive = entry.name.endsWith('.jsonl');
    const otherFile = !isArchive;
    if (otherFile)
      continue;
    const match = /^([a-f0-9-]{36})-([0-9]{16})\.jsonl$/.exec(entry.name);
    const invalidName = match === null;
    if (invalidName)
      throw new Error(`Unrecognized archive file: ${entry.name}`);
    const differentStore = storeId !== null && storeId !== match[1];
    if (differentStore)
      throw new Error('Export destination contains multiple stores.');
    storeId = match[1];
    const newest = latest === null || entry.name > latest;
    if (newest)
      latest = entry.name;
    count++;
  }
  return { latest, storeId, count };
}
/** Follow the archive chain backwards; memory does not grow with file count. */
export async function verifyHistoryArchive(directory: string) {
  const files = await archiveFiles(directory);
  let file = files.latest;
  let sequence = 0;
  let records = 0;
  let expectedEnd: number | undefined;
  let segments = 0;
  let hasSegment = file !== null;
  while (hasSegment) {
    const currentFile = file;
    const missingFile = currentFile === null;
    if (missingFile)
      break;
    const safeName = /^[-a-f0-9]+\.jsonl$/.test(currentFile);
    const unsafeName = !safeName;
    if (unsafeName)
      throw new Error('Invalid previous archive filename.');
    const segment = await verifyHistorySegment(join(directory, currentFile));
    const sameStore = segment.storeId === files.storeId;
    const followsPrevious = expectedEnd === undefined || segment.through === expectedEnd;
    const valid = sameStore && followsPrevious && segment.after < segment.through;
    const invalid = !valid;
    if (invalid)
      throw new Error(`Archive store or sequence mismatch: ${file}`);
    const newest = segments === 0;
    if (newest)
      sequence = segment.through;
    expectedEnd = segment.after;
    records += segment.count;
    segments++;
    file = segment.previous;
    hasSegment = file !== null;
  }
  const complete = segments === files.count && (expectedEnd === undefined || expectedEnd === 0);
  const incomplete = !complete;
  if (incomplete)
    throw new Error('Archive has a gap or an unlinked segment.');
  return { storeId: files.storeId, sequence, records, segments, file: files.latest };
}
async function resume(directory: string, storeId: string) {
  const verified = await verifyHistoryArchive(directory);
  const sameStore = verified.storeId === null || verified.storeId === storeId;
  const differentStore = !sameStore;
  if (differentStore)
    throw new Error('Export destination belongs to another store.');
  const path = join(directory, 'checkpoint.json');
  const hasCheckpoint = existsSync(path);
  if (hasCheckpoint) {
    const saved = checkpointSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const valid = saved.storeId === storeId && saved.sequence <= verified.sequence;
    const invalid = !valid;
    if (invalid)
      throw new Error('Export checkpoint is ahead of its verified archives.');
  }
  const file = verified.file;
  const hasFile = file !== null;
  if (hasFile)
    checkpoint(directory, { storeId, sequence: verified.sequence, file });
  return { sequence: verified.sequence, file };
}
/** Backup only: bounded pages, short database reads, never deletes history. */
export async function exportHistory(source: HistorySource, output: string, options: {
  maxBytes?: number;
  maxAgeMs?: number;
  watch?: AbortSignal;
} = {}) {
  const directory = resolve(output);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.export.lock');
  const ownership = await openNodeSqlite(lock, false);
  try {
    ownership.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    await source.flush();
    const status = await source.status();
    const storeId = status.storeId;
    const resumed = await resume(directory, storeId);
    let sequence = resumed.sequence;
    let previous = resumed.file;
    let through = status.durableSequence;
    const ahead = sequence > through;
    if (ahead)
      throw new Error('Export checkpoint is ahead of this store; preserve both copies.');
    let segment: ReturnType<typeof openSegment> | undefined;
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const maxAgeMs = options.maxAgeMs ?? 60000;
    async function finalize(): Promise<void> {
      const active = segment;
      const hasSegment = active !== undefined;
      if (hasSegment) {
        previous = await finishSegment(active, directory, storeId);
        segment = undefined;
      }
    }
    let watching = true;
    try {
      while (watching) {
        let catchingUp = sequence < through;
        while (catchingUp) {
          const page = await source.list({ after: sequence, through, limit: 256 });
          const validPage = page.storeId === storeId && page.records.length > 0;
          const invalidPage = !validPage;
          if (invalidPage)
            throw new Error('History changed identity or has a missing page. Export stopped.');
          for (const record of page.records) {
            const contiguous = record.sequence === sequence + 1;
            const hasGap = !contiguous;
            if (hasGap)
              throw new Error(`History gap before sequence ${record.sequence}. Export stopped.`);
            const line = archiveLine(record);
            const rotates = segment !== undefined && (segment.bytes + Buffer.byteLength(line) > maxBytes || Date.now() - segment.started >= maxAgeMs);
            if (rotates)
              await finalize();
            segment ??= openSegment(directory, storeId, sequence, previous);
            writeAll(segment.handle, line);
            segment.hash.update(line);
            segment.bytes += Buffer.byteLength(line);
            segment.count++;
            segment.through = record.sequence;
            sequence = record.sequence;
          }
          catchingUp = sequence < through;
        }
        const expired = segment !== undefined && Date.now() - segment.started >= maxAgeMs;
        if (expired)
          await finalize();
        watching = options.watch !== undefined && !options.watch.aborted;
        const finished = !watching;
        if (finished)
          break;
        await delay(250, undefined, { signal: options.watch }).catch(error => {
          const aborted = error instanceof Error && error.name === 'AbortError';
          const unexpectedError = !aborted;
          if (unexpectedError)
            throw error;
        });
        await source.flush();
        const current = await source.status();
        const sameStore = current.storeId === storeId;
        const differentStore = !sameStore;
        if (differentStore)
          throw new Error('History store changed while exporting.');
        through = current.durableSequence;
      }
      await finalize();
    }
    finally {
      const active = segment;
      const remainsOpen = active !== undefined && active.open;
      if (remainsOpen)
        closeSync(active.handle);
    }
    return { storeId, sequence, directory };
  }
  finally {
    ownership.close();
  }
}
function archiveLine(record: HistoryRecord): string {
  const { payload: _decoded, ...portable } = record;
  return `${JSON.stringify(portable)}\n`;
}
function openSegment(directory: string, storeId: string, after: number, previous: string | null) {
  const path = join(directory, `.segment-${randomUUID()}.tmp`);
  const handle = openSync(path, 'wx', 0o600);
  const line = `${JSON.stringify({ format: ARCHIVE_FORMAT, storeId, after, previous })}\n`;
  try {
    writeAll(handle, line);
    return { handle, path, after, through: after, count: 0, bytes: Buffer.byteLength(line), hash: createHash('sha256').update(line), started: Date.now(), open: true };
  } catch (error) {
    closeSync(handle);
    throw error;
  }
}
async function finishSegment(segment: ReturnType<typeof openSegment>, directory: string, storeId: string): Promise<string> {
  writeAll(segment.handle, `${JSON.stringify({ through: segment.through, count: segment.count, checksum: segment.hash.digest('hex') })}\n`);
  fsyncSync(segment.handle);
  closeSync(segment.handle);
  segment.open = false;
  await verifyHistorySegment(segment.path);
  const name = `${storeId}-${String(segment.through).padStart(16, '0')}.jsonl`;
  const destination = join(directory, name);
  const exists = existsSync(destination);
  if (exists)
    throw new Error(`Refusing to overwrite finalized history archive: ${destination}`);
  renameSync(segment.path, destination);
  syncDirectory(directory);
  checkpoint(directory, { storeId, sequence: segment.through, file: name });
  return name;
}
