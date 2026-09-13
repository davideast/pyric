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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export type AssetOrigin = 'cache' | 'pool' | 'source' | 'interim' | 'fallback';

export interface ResolvedAsset {
  data: Uint8Array;
  contentType: string;
  origin: AssetOrigin;
}

export interface AssetResolverOptions {
  dir: string;
  source?: AssetSource;
  /** Produces bytes when nothing else can answer. `kind` says which case
   *  this is: `interim` means a source is still generating behind this
   *  response and the image should look provisional, `fallback` means the
   *  answer is final for now (no source, or one that failed). */
  fallback: (
    req: AssetRequest,
    kind: 'fallback' | 'interim',
  ) => { data: Uint8Array; contentType: string };
  fetchImpl?: typeof fetch;
  /** How long a resolve waits for the source before serving the fallback
   *  bytes as an `interim` result while the source finishes in the
   *  background. The completed result is cached as usual, so the next
   *  fetch upgrades; a source failure after an interim response caches
   *  nothing and the next fetch retries.
   *
   *  Default 0: any source that does not resolve synchronously yields an
   *  instant placeholder rather than blocking the first paint. A slow
   *  generator is the case interim exists for, so making it wait would
   *  defeat the point; the only cost is that a fast async source shows a
   *  placeholder for one request before the next fetch upgrades. */
  sourceDeadlineMs?: number;
  /** Called with a key whose interim placeholder has just been superseded by
   *  a materialised source result. It fires exactly when a placeholder
   *  someone was actually served is now stale, so a served host can tell the
   *  page to re-request that key: never for a source that answered without an
   *  interim, and never for one that failed (nothing was cached, so the next
   *  fetch retries and may yield another interim). Failures inside it are
   *  contained — a listener never fails the resolve that produced the bytes. */
  onMaterialised?: (key: string) => void;
  /** Most times `source` may run over this resolver's lifetime. A source can
   *  cost money per call, and the route that drives it answers any uid, so an
   *  application loop or a request the developer did not make cannot be
   *  allowed to invoke it without bound. Past the limit every key falls back
   *  to the built-in avatar and nothing is cached, so raising the limit or
   *  restarting resumes generation. Default 100. */
  maxSourceInvocations?: number;
  /** Called once, the first time the invocation limit refuses a key, so the
   *  host can say why avatars stopped generating instead of changing
   *  behaviour silently. */
  onSourceLimit?: (limit: number) => void;
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
  key: string,
  data: Uint8Array,
  contentType: string,
): void {
  const ext = extensionFor(contentType);
  if (!ext) return; // unreachable: callers only reach here with a known type
  const file = `${key}.${ext}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), data);
  // Other users can finish downloading while this source is awaiting bytes.
  // Merge against the current index inside this synchronous write operation.
  const manifest = loadManifest(dir);
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
  const sourceDeadlineMs = opts.sourceDeadlineMs ?? 0;
  const inFlight = new Map<string, Promise<ResolvedAsset>>();
  const maxSourceInvocations = opts.maxSourceInvocations ?? 100;
  let sourceInvocations = 0;
  let limitAnnounced = false;
  /** Keys an interim response was actually served for. Membership is the
   *  precondition for `onMaterialised`: without it a "the image is ready"
   *  signal would fire for keys no one ever saw a placeholder for. */
  const interimServed = new Set<string>();

  /** Announce that a placeholder someone was shown has been superseded.
   *  A no-op for a key with no outstanding interim, so a synchronous source
   *  is silent; the membership is consumed so one placeholder announces
   *  once. */
  function announceMaterialised(key: string): void {
    const supersededAPlaceholder = interimServed.delete(key);
    if (!supersededAPlaceholder) return;
    if (!opts.onMaterialised) return;
    try {
      opts.onMaterialised(key);
    } catch {
      // Failure containment: a throwing listener never breaks the resolve.
    }
  }

  /** Wait for `pending` up to the deadline; past it, serve the fallback
   *  bytes as `interim` while `pending` keeps running (it stays in the
   *  in-flight map, so the source still executes exactly once and its
   *  result still lands in the cache). `runSource` never rejects, so the
   *  abandoned promise cannot become an unhandled rejection.
   *
   *  At the default deadline of 0 the timer is a macrotask, so a source
   *  that resolves synchronously still wins the race on the microtask
   *  queue and answers directly; only genuine asynchronous work yields an
   *  interim response. */
  async function withDeadline(
    pending: Promise<ResolvedAsset>,
    req: AssetRequest,
  ): Promise<ResolvedAsset> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((expire) => {
      timer = setTimeout(() => expire(null), sourceDeadlineMs);
    });
    const winner = await Promise.race([pending, deadline]);
    clearTimeout(timer);
    if (winner !== null) return winner;
    interimServed.add(req.key);
    return { ...opts.fallback(req, 'interim'), origin: 'interim' };
  }

  async function runSource(
    req: AssetRequest,
    source: AssetSource,
  ): Promise<ResolvedAsset> {
    let result: AssetResult;
    try {
      result = await source(req);
    } catch {
      return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
    }

    if ('data' in result) {
      const ext = extensionFor(result.contentType);
      if (!ext) return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
      try {
        cacheSourceResult(opts.dir, req.key, result.data, result.contentType);
        announceMaterialised(req.key);
      } catch {
        // Failure containment: serve the bytes the source produced even
        // when persisting them to disk fails. Nothing is announced — the
        // next fetch of this key re-runs the source rather than upgrading.
      }
      return { data: result.data, contentType: result.contentType, origin: 'source' };
    }

    let response: Response;
    try {
      response = await fetchImpl(result.url);
    } catch {
      return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
    }
    if (!response.ok) {
      return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
    }
    const contentType = normalizeContentType(response.headers.get('content-type'));
    if (!contentType || !extensionFor(contentType)) {
      return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
    }
    const data = new Uint8Array(await response.arrayBuffer());
    try {
      cacheSourceResult(opts.dir, req.key, data, contentType);
      announceMaterialised(req.key);
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
      let pending = inFlight.get(req.key);
      if (!pending) {
        // Counted per new invocation, not per request: joining an in-flight
        // generation is free, and a cached key never arrives here at all.
        if (sourceInvocations >= maxSourceInvocations) {
          if (!limitAnnounced) {
            limitAnnounced = true;
            try {
              opts.onSourceLimit?.(maxSourceInvocations);
            } catch {
              // A host's notification must not break a resolve.
            }
          }
          return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
        }
        sourceInvocations++;
        pending = runSource(req, opts.source).finally(() => {
          inFlight.delete(req.key);
        });
        inFlight.set(req.key, pending);
      }
      return withDeadline(pending, req);
    }

    const pool = manifest?.images.filter((image) => image.key === undefined) ?? [];
    if (pool.length > 0) {
      const picked = pickPoolImage(pool, req.seed);
      const hit = readManifestImage(opts.dir, picked);
      if (hit) return { ...hit, origin: 'pool' };
    }

    return { ...opts.fallback(req, 'fallback'), origin: 'fallback' };
  }

  return { resolve };
}
