import { createHash, randomUUID, type Hash } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A stored object's bytes, as its row records them. */
export interface StoredBytes {
  sha256: string;
  size: number;
}

/** An upload in progress: one file its parts append to, hashed as they arrive. */
export interface StagedFile {
  readonly path: string;
  readonly received: number;
  append(bytes: Uint8Array): void;
  /** The hash and size of everything appended; no append may follow. Sealing again returns the same. */
  seal(): StoredBytes;
  discard(): void;
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
  /** Start a staged file named `objects/.staging/<name>`. */
  stage(name: string): StagedFile;
  /** Make a sealed staged file durable and rename it to its hash; its bytes are not read. */
  adopt(file: StagedFile): StoredBytes;
  /** Remove every staged file. Only a host that owns the store, before it admits writes, may call this. */
  clearStaging(): void;
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}

function isMissing(error: unknown): boolean {
  return hasCode(error, 'ENOENT');
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
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

  function appendTo(descriptor: number, bytes: Uint8Array): void {
    let written = 0;
    while (written < bytes.byteLength) written += writeSync(descriptor, bytes, written, bytes.byteLength - written);
  }

  /** Move a durable file to the name of its hash and make the rename durable. */
  function publish(file: string, sha256: string): void {
    const target = pathOf(sha256);
    const shard = dirname(target);
    mkdirSync(shard, { recursive: true });
    // Identical bytes have the same name, so replacing an existing file is harmless.
    renameSync(file, target);
    fsyncDirectory(shard);
    fsyncDirectory(directory);
  }

  function stagingPath(name: string): string {
    const safeName = /^[A-Za-z0-9-]+$/.test(name);
    if (!safeName) throw new Error('A staged file name must be letters, digits, and dashes.');
    mkdirSync(staging, { recursive: true });
    return join(staging, name);
  }

  function stage(name: string): StagedFile {
    const path = stagingPath(name);
    closeSync(openSync(path, 'wx'));
    let hash: Hash | undefined = createHash('sha256');
    let sealedAs: StoredBytes | undefined;
    let received = 0;
    return {
      path,
      get received() { return received; },
      append(bytes) {
        const current = hash;
        const sealed = current === undefined;
        if (sealed) throw new Error('A sealed staged file cannot be appended to.');
        const descriptor = openSync(path, 'a');
        try { appendTo(descriptor, bytes); } finally { closeSync(descriptor); }
        current.update(bytes);
        received += bytes.byteLength;
      },
      seal() {
        const current = hash;
        const unsealed = current !== undefined;
        if (unsealed) {
          sealedAs = { sha256: current.digest('hex'), size: received };
          hash = undefined;
        }
        return sealedAs!;
      },
      discard() {
        rmSync(path, { force: true });
      },
    };
  }

  return {
    write(bytes) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const temporary = stagingPath(randomUUID());
      try {
        const descriptor = openSync(temporary, 'wx');
        try {
          appendTo(descriptor, bytes);
          fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
        publish(temporary, sha256);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      return { sha256, size: bytes.byteLength };
    },
    stage,
    adopt(file) {
      const stored = file.seal();
      fsyncFile(file.path);
      publish(file.path, stored.sha256);
      return stored;
    },
    clearStaging() {
      let names: string[] = [];
      try { names = readdirSync(staging); }
      catch (error) {
        // No staging directory, or no object directory at all: nothing is staged.
        if (hasCode(error, 'ENOENT', 'ENOTDIR')) return;
        throw error;
      }
      for (const name of names) rmSync(join(staging, name), { force: true, recursive: true });
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
