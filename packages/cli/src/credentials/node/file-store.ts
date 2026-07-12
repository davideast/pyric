/**
 * Node `CredentialStore` over a JSON file (default `~/.pyric/credentials.json`).
 * Hardened per the pre-mortem: writes are atomic (temp + rename), the file is
 * `0600` (it holds a refresh token), and `read()` returns `null` on a missing OR
 * corrupt/unknown file — it never throws, so a damaged store reads as logged-out.
 */
import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CredentialStore, StoredCredential } from '../core/types.js';

export function defaultCredentialPath(): string {
  return join(homedir(), '.pyric', 'credentials.json');
}

export function fileCredentialStore(path: string = defaultCredentialPath()): CredentialStore {
  return {
    async read(): Promise<StoredCredential | null> {
      let raw: string;
      try {
        raw = await readFile(path, 'utf-8');
      } catch {
        return null; // missing -> logged out
      }
      try {
        const parsed = JSON.parse(raw) as Partial<StoredCredential>;
        if (parsed && parsed.version === 1 && typeof parsed.refreshToken === 'string' && Array.isArray(parsed.scopes)) {
          return parsed as StoredCredential;
        }
        return null; // unknown shape -> logged out (don't trust a partial/old file)
      } catch {
        return null; // corrupt JSON -> logged out, never throw
      }
    },

    async write(cred: StoredCredential): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600); // belt-and-suspenders vs umask
      await rename(tmp, path); // atomic swap
      await chmod(path, 0o600);
    },

    async clear(): Promise<void> {
      try {
        await unlink(path);
      } catch {
        /* already gone */
      }
    },
  };
}
