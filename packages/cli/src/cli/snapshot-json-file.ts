import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isStorageReference, type StorageObjectReference, type StorageStateEntry } from '../serve/state-file.js';
import type { PyricStateFile } from '../serve/state-store.js';
import { MAX_STORAGE_OP_BYTES } from '../serve/worker/protocol.js';

export type SnapshotObjectBytes = Uint8Array | AsyncIterable<Uint8Array> | { file: string };

export class SnapshotFileObjectError extends Error {}

export function isJsonSnapshotFile(outputName: string): boolean {
  return /\.json$/i.test(outputName.trim());
}

async function collectBytes(
  reference: StorageObjectReference,
  bytes: SnapshotObjectBytes,
): Promise<Buffer> {
  if ('file' in bytes) {
    try {
      const st = statSync(bytes.file);
      if (st.size > MAX_STORAGE_OP_BYTES) {
        throw new SnapshotFileObjectError(
          `Storage object '${reference.path}' exceeds the 8 MiB single-file limit; pass a directory name without .json to --out.`,
        );
      }
      return readFileSync(bytes.file);
    } catch (error) {
      const missingFile = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      if (missingFile) {
        throw new SnapshotFileObjectError(
          `Storage object '${reference.path}' has no file for hash ${reference.sha256}.`,
        );
      }
      throw error;
    }
  }
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of bytes) {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    total += buf.byteLength;
    if (total > MAX_STORAGE_OP_BYTES) {
      throw new SnapshotFileObjectError(
        `Storage object '${reference.path}' exceeds the 8 MiB single-file limit; pass a directory name without .json to --out.`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

export async function inlineSnapshotObjects(
  entries: readonly StorageStateEntry[],
  readObject: (sha256: string) => Promise<SnapshotObjectBytes>,
): Promise<{ entries: StorageStateEntry[]; uniqueObjects: number }> {
  const resolvedByHash = new Map<string, string>();
  const out: StorageStateEntry[] = [];
  for (const entry of entries) {
    if (!isStorageReference(entry)) {
      if (entry.metadata.size > MAX_STORAGE_OP_BYTES) {
        throw new SnapshotFileObjectError(
          `Storage object '${entry.metadata.fullPath}' is ${String(entry.metadata.size)} bytes, above the 8 MiB single-file limit; pass a directory name without .json to --out.`,
        );
      }
      const rawBytes = Buffer.from(entry.dataBase64, 'base64');
      const digest = createHash('sha256').update(rawBytes).digest('hex');
      resolvedByHash.set(digest, entry.dataBase64);
      out.push(entry);
      continue;
    }
    if (entry.size > MAX_STORAGE_OP_BYTES) {
      throw new SnapshotFileObjectError(
        `Storage object '${entry.path}' is ${String(entry.size)} bytes, above the 8 MiB single-file limit; pass a directory name without .json to --out.`,
      );
    }
    let dataBase64 = resolvedByHash.get(entry.sha256);
    if (dataBase64 === undefined) {
      const sourceBytes = await readObject(entry.sha256);
      const buffer = await collectBytes(entry, sourceBytes);
      const actualHash = createHash('sha256').update(buffer).digest('hex');
      const intact = buffer.byteLength === entry.size && actualHash === entry.sha256;
      if (!intact) {
        throw new SnapshotFileObjectError(
          `Storage object '${entry.path}' did not arrive as the bytes its hash ${entry.sha256} names.`,
        );
      }
      dataBase64 = buffer.toString('base64');
      resolvedByHash.set(entry.sha256, dataBase64);
    }
    out.push({
      dataBase64,
      blobType: entry.blobType,
      metadata: entry.metadata,
    });
  }
  return { entries: out, uniqueObjects: resolvedByHash.size };
}

export function writeJsonSnapshotAtomically(outPath: string, promoted: PyricStateFile): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const partialDocument = `${outPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(partialDocument, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');
    renameSync(partialDocument, outPath);
  } catch (error) {
    rmSync(partialDocument, { force: true });
    throw error;
  }
}
