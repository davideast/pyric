import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A stored object's bytes, as its row records them. */
export interface StoredBytes {
  sha256: string;
  size: number;
}

/**
 * Immutable files named by the SHA-256 of their bytes, under `objects/<ab>/`.
 * A file is durable before `write` returns, so a row committed after it never
 * names bytes that are missing. Files no row names are left for a sweep.
 */
export interface BlobStore {
  write(bytes: Uint8Array): StoredBytes;
  read(stored: StoredBytes): Uint8Array<ArrayBuffer>;
  /** At most `length` bytes from `offset`, read from the file at that position. */
  readRange(stored: StoredBytes, offset: number, length: number): Uint8Array<ArrayBuffer>;
  /** The file's size, or undefined when it is missing. */
  size(sha256: string): number | undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Make a rename into `directory` durable. Windows has no directory handle to flush. */
function fsyncDirectory(directory: string): void {
  const flushable = process.platform !== 'win32';
  if (!flushable) return;
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Opening the store touches nothing; the first write creates its directories. */
export function createBlobStore(directory: string): BlobStore {
  const staging = join(directory, '.staging');

  function pathOf(sha256: string): string {
    const validHash = SHA256_HEX.test(sha256);
    if (!validHash) throw new Error('Persisted Storage object names an invalid content hash.');
    return join(directory, sha256.slice(0, 2), sha256);
  }

  function readAt(stored: StoredBytes, offset: number, length: number): Uint8Array<ArrayBuffer> {
    const descriptor = openSync(pathOf(stored.sha256), 'r');
    try {
      const actualSize = fstatSync(descriptor).size;
      const mismatchedFile = actualSize !== stored.size;
      if (mismatchedFile) throw new Error('Persisted Storage bytes do not match their recorded size.');
      const start = Math.min(offset, stored.size);
      // Its own buffer, never a slice of Node's shared pool, so it can be transferred.
      const bytes = new Uint8Array(Math.min(length, stored.size - start));
      let filled = 0;
      while (filled < bytes.byteLength) {
        const read = readSync(descriptor, bytes, filled, bytes.byteLength - filled, start + filled);
        const truncated = read === 0;
        if (truncated) throw new Error('Persisted Storage bytes ended before their recorded size.');
        filled += read;
      }
      return bytes;
    } finally { closeSync(descriptor); }
  }

  return {
    write(bytes) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const target = pathOf(sha256);
      mkdirSync(staging, { recursive: true });
      const temporary = join(staging, randomUUID());
      try {
        const descriptor = openSync(temporary, 'wx');
        try {
          let written = 0;
          while (written < bytes.byteLength) written += writeSync(descriptor, bytes, written, bytes.byteLength - written);
          fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
        const shard = dirname(target);
        mkdirSync(shard, { recursive: true });
        // Identical bytes have the same name, so replacing an existing file is harmless.
        renameSync(temporary, target);
        fsyncDirectory(shard);
        fsyncDirectory(directory);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      return { sha256, size: bytes.byteLength };
    },
    read(stored) {
      return readAt(stored, 0, stored.size);
    },
    readRange(stored, offset, length) {
      return readAt(stored, offset, length);
    },
    size(sha256) {
      try { return statSync(pathOf(sha256)).size; }
      catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
  };
}
