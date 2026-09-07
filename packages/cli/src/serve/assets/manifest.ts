/**
 * The per-directory asset manifest: what images already exist on disk for
 * this project, and which of them are pinned to a specific lookup key.
 *
 * An image WITH `key` is a materialised assignment — the resolver serves it
 * for an exact key match with no further work (resolver.ts step 1). An
 * image WITHOUT `key` is part of the deterministic pool the resolver picks
 * from when nothing else resolves the request (resolver.ts step 3). A
 * single directory's manifest can hold both kinds of entry at once.
 *
 * Writes are atomic (tmp + rename, same volume), mirroring the state-store
 * idiom in `serve/state-store.ts`: a crash never leaves a truncated
 * manifest.json behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ASSET_MANIFEST_VERSION = 1 as const;
export const ASSET_MANIFEST_FILENAME = 'manifest.json';

export interface AssetManifestImage {
  /** Plain basename on disk, relative to the manifest's directory. Never a
   *  path (no `/`, no `\`, no `..` segment) — see {@link assertPlainBasename}. */
  file: string;
  contentType?: string;
  /** Present only for a materialised, exact-lookup assignment. Absent for a
   *  pool image the resolver picks from deterministically. */
  key?: string;
}

export interface AssetManifest {
  version: typeof ASSET_MANIFEST_VERSION;
  name?: string;
  images: AssetManifestImage[];
}

export class AssetManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetManifestError';
  }
}

/** Reject any basename carrying a path separator or a `..` traversal
 *  segment. Same spirit as the `basename()` guard on the sdk route in
 *  `serve/namespace.ts`, but this validates an authored value rather than
 *  flattening a URL, so a bad entry fails closed instead of being silently
 *  corrected. */
function assertPlainBasename(file: unknown, context: string): asserts file is string {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AssetManifestError(`${context}: "file" must be a non-empty string.`);
  }
  if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') {
    throw new AssetManifestError(
      `${context}: "file" must be a plain basename with no path separators or "..", got ${JSON.stringify(file)}.`,
    );
  }
}

function assertOptionalString(value: unknown, field: string, context: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new AssetManifestError(`${context}: "${field}" must be a string when present.`);
  }
}

function parseManifest(raw: unknown, path: string): AssetManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AssetManifestError(`asset manifest at ${path} is not an object.`);
  }
  const candidate = raw as { version?: unknown; name?: unknown; images?: unknown };
  if (candidate.version !== ASSET_MANIFEST_VERSION) {
    throw new AssetManifestError(
      `asset manifest at ${path} has version ${JSON.stringify(candidate.version)}; this ` +
        `@pyric/cli expects ${ASSET_MANIFEST_VERSION}. Delete or regenerate it to continue.`,
    );
  }
  assertOptionalString(candidate.name, 'name', `asset manifest at ${path}`);
  if (!Array.isArray(candidate.images)) {
    throw new AssetManifestError(`asset manifest at ${path}: "images" must be an array.`);
  }
  const images: AssetManifestImage[] = candidate.images.map((entry, index) => {
    const context = `asset manifest at ${path}, images[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AssetManifestError(`${context}: must be an object.`);
    }
    const image = entry as { file?: unknown; contentType?: unknown; key?: unknown };
    assertPlainBasename(image.file, context);
    assertOptionalString(image.contentType, 'contentType', context);
    assertOptionalString(image.key, 'key', context);
    const parsed: AssetManifestImage = { file: image.file };
    if (image.contentType !== undefined) parsed.contentType = image.contentType as string;
    if (image.key !== undefined) parsed.key = image.key as string;
    return parsed;
  });
  const manifest: AssetManifest = { version: ASSET_MANIFEST_VERSION, images };
  if (candidate.name !== undefined) manifest.name = candidate.name as string;
  return manifest;
}

/** Read `manifest.json` from `dir`. Returns null when the file doesn't
 *  exist. Throws {@link AssetManifestError} on an unknown version (fail
 *  closed) or a malformed shape. */
export function loadManifest(dir: string): AssetManifest | null {
  const path = join(dir, ASSET_MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new AssetManifestError(
      `asset manifest at ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  return parseManifest(raw, path);
}

/** Write `manifest.json` into `dir`, atomically (tmp + rename). Creates
 *  `dir` recursively when it doesn't exist. */
export function saveManifest(dir: string, manifest: AssetManifest): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ASSET_MANIFEST_FILENAME);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(tmp, path); // same volume — atomic replace
}
