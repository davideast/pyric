import { existsSync, readFileSync, statSync } from 'node:fs';
import type { StorageStateRecord } from 'pyric/storage/internal';
import { hashFile } from './hosted/persistence/blob-store.js';
import { isStorageReference, objectFileIn, StateFileError, type StorageObjectReference, type StorageStateEntry } from './state-file.js';

/** The file a reference names in `directory`, after checking it holds exactly those bytes. */
export function verifiedObjectFile(entry: StorageObjectReference, directory: string): string {
  const file = objectFileIn(directory, entry.sha256);
  const missing = !existsSync(file);
  if (missing) throw new StateFileError(`Storage object '${entry.path}' refers to ${file}, which does not exist.`);
  const intact = statSync(file).size === entry.size && hashFile(file) === entry.sha256;
  const rotted = !intact;
  if (rotted) throw new StateFileError(`Storage object '${entry.path}' refers to ${file}, whose bytes do not match its hash.`);
  return file;
}

/** Check every file a document refers to before any of it is written anywhere. */
export function verifyReferencedObjects(entries: readonly StorageStateEntry[], directory: string): void {
  for (const entry of entries) {
    const referenced = isStorageReference(entry);
    if (referenced) verifiedObjectFile(entry, directory);
  }
}

/** The document's Storage with every reference read back inline, for stores that keep bytes in the document. */
export function inlineStorage(entries: readonly StorageStateEntry[], directory: string): StorageStateRecord[] {
  return entries.map(entry => {
    const inline = !isStorageReference(entry);
    if (inline) return entry;
    const bytes = readFileSync(verifiedObjectFile(entry, directory));
    return { dataBase64: bytes.toString('base64'), blobType: entry.blobType, metadata: entry.metadata };
  });
}
