/**
 * The asset resolver: given a lookup key, produce image bytes and a
 * content type, preferring — in order — a materialised cache entry, a
 * caller-supplied source, a deterministic pick from a static pool, and
 * finally a caller-supplied fallback.
 *
 * This module owns no HTTP route and no configuration; it is the seam
 * other serve-layer code mounts a route onto. See manifest.ts for the
 * on-disk manifest shape and content-types.ts for the known image types.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadManifest,
  saveManifest,
  type AssetManifest,
  type AssetManifestImage,
} from './manifest.js';
import { contentTypeFor, extensionFor } from './content-types.js';

export interface AssetRequest {
  key: string;
  seed: string;
  context: Record<string, unknown>;
}

export type AssetResult = { url: string } | { data: Uint8Array; contentType: string };

export type AssetSource = (req: AssetRequest) => AssetResult | Promise<AssetResult>;

export type AssetOrigin = 'cache' | 'pool' | 'source' | 'fallback';

export interface ResolvedAsset {
  data: Uint8Array;
  contentType: string;
  origin: AssetOrigin;
}

export interface AssetResolverOptions {
  dir: string;
  source?: AssetSource;
  fallback: (req: AssetRequest) => { data: Uint8Array; contentType: string };
  fetchImpl?: typeof fetch;
}

export interface AssetResolver {
  resolve(req: AssetRequest): Promise<ResolvedAsset>;
}

/** FNV-1a, 32-bit, over the UTF-8 bytes of `input`. Deterministic across
 *  processes and platforms — the pool pick (step 3) depends on that. */
function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Read one manifest image's bytes off disk. Returns null on any read
 *  failure (missing file, permission error, ...) or when its content type
 *  can't be determined — both are treated as a miss by the caller, never
 *  as a thrown error. */
function readManifestImage(
  dir: string,
  image: AssetManifestImage,
): { data: Uint8Array; contentType: string } | null {
  const contentType = image.contentType ?? contentTypeFor(image.file);
  if (!contentType) return null;
  try {
    const data = new Uint8Array(readFileSync(join(dir, image.file)));
    return { data, contentType };
  } catch {
    return null;
  }
}

function pickPoolImage(pool: AssetManifestImage[], seed: string): AssetManifestImage {
  const index = fnv1a32(seed) % pool.length;
  return pool[index]!;
}

/** Persist a source-produced asset into `dir` and append a keyed manifest
 *  entry for it. Any failure here is swallowed by the caller — a cache
 *  write never fails the resolve that produced the bytes. */
function cacheSourceResult(
  dir: string,
  manifest: AssetManifest | null,
  key: string,
  data: Uint8Array,
  contentType: string,
): void {
  const ext = extensionFor(contentType);
  if (!ext) return; // unreachable: callers only reach here with a known type
  const file = `${key}.${ext}`;
  writeFileSync(join(dir, file), data);
  const images = (manifest?.images ?? []).filter((image) => image.key !== key);
  images.push({ file, contentType, key });
  const updated: AssetManifest = { version: 1, images };
  if (manifest?.name !== undefined) updated.name = manifest.name;
  saveManifest(dir, updated);
}

function normalizeContentType(headerValue: string | null): string | null {
  if (!headerValue) return null;
  return headerValue.split(';', 1)[0]!.trim();
}

export function createAssetResolver(opts: AssetResolverOptions): AssetResolver {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const inFlight = new Map<string, Promise<ResolvedAsset>>();

  async function runSource(
    req: AssetRequest,
    source: AssetSource,
    manifest: AssetManifest | null,
  ): Promise<ResolvedAsset> {
    let result: AssetResult;
    try {
      result = await source(req);
    } catch {
      return { ...opts.fallback(req), origin: 'fallback' };
    }

    if ('data' in result) {
      const ext = extensionFor(result.contentType);
      if (!ext) return { ...opts.fallback(req), origin: 'fallback' };
      try {
        cacheSourceResult(opts.dir, manifest, req.key, result.data, result.contentType);
      } catch {
        // Failure containment: serve the bytes the source produced even
        // when persisting them to disk fails.
      }
      return { data: result.data, contentType: result.contentType, origin: 'source' };
    }

    let response: Response;
    try {
      response = await fetchImpl(result.url);
    } catch {
      return { ...opts.fallback(req), origin: 'fallback' };
    }
    if (!response.ok) {
      return { ...opts.fallback(req), origin: 'fallback' };
    }
    const contentType = normalizeContentType(response.headers.get('content-type'));
    if (!contentType || !extensionFor(contentType)) {
      return { ...opts.fallback(req), origin: 'fallback' };
    }
    const data = new Uint8Array(await response.arrayBuffer());
    try {
      cacheSourceResult(opts.dir, manifest, req.key, data, contentType);
    } catch {
      // Same containment as the { data } branch above.
    }
    return { data, contentType, origin: 'source' };
  }

  async function resolve(req: AssetRequest): Promise<ResolvedAsset> {
    const manifest = existsSync(opts.dir) ? loadManifest(opts.dir) : null;

    const keyed = manifest?.images.find((image) => image.key === req.key);
    if (keyed) {
      const hit = readManifestImage(opts.dir, keyed);
      if (hit) return { ...hit, origin: 'cache' };
      // Missing/unreadable file: fall through as a miss, same as no entry.
    }

    if (opts.source) {
      const existing = inFlight.get(req.key);
      if (existing) return existing;
      const promise = runSource(req, opts.source, manifest).finally(() => {
        inFlight.delete(req.key);
      });
      inFlight.set(req.key, promise);
      return promise;
    }

    const pool = manifest?.images.filter((image) => image.key === undefined) ?? [];
    if (pool.length > 0) {
      const picked = pickPoolImage(pool, req.seed);
      const hit = readManifestImage(opts.dir, picked);
      if (hit) return { ...hit, origin: 'pool' };
    }

    return { ...opts.fallback(req), origin: 'fallback' };
  }

  return { resolve };
}
