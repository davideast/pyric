/**
 * Portable Firebase Hosting deploy core. Zero `node:*` imports —
 * file I/O and token acquisition are pushed to the caller.
 *
 * Five-call dance:
 *   1. POST /sites/{siteId}/versions                        (create version, with the serving config)
 *   2. POST {versionName}:populateFiles                     (manifest)
 *   3. POST {uploadUrl}/{hash}                              (per file)
 *   4. PATCH {versionName}?update_mask=status               (FINALIZED)
 *   5. POST /sites/{siteId}/releases?versionName=...        (release)
 *
 * Channel deploys (`channelId` set) add step 0 — ensure the preview
 * channel exists — and re-aim step 5 at
 *   POST /projects/-/sites/{siteId}/channels/{channelId}/releases?versionName=...
 * (mirrors firebase-tools `createRelease`,
 * clones/firebase-tools/src/hosting/api.ts:481-493). Live deploys
 * are byte-for-byte unchanged.
 *
 * Same Node and browser. The Node adapter walks `localDir`; a
 * browser adapter could feed `<input webkitdirectory>` files.
 */
import { ensureChannel, type ChannelResource } from './channels.js';
import { gzip } from './gzip.js';
import { sha256Hex } from './hash.js';
import { buildVersionConfig } from './config.js';
import type {
  DeployHostingError,
  DeployHostingResult,
  HostingErrorCode,
  HostingJsonConfig,
} from './spec.js';
import type { PopulateFilesResponse, ReleaseResource, VersionResource } from './types.js';

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1';

export interface DeployHostingFilesInput {
  siteId: string;
  /**
   * Files to deploy. `path` is the public URL path served by Hosting
   * — leading `/` is added if missing; backslashes normalized to
   * forward slashes.
   */
  files: { path: string; bytes: Uint8Array }[];
  /** Opaque OAuth 2.0 access token. Caller mints. */
  accessToken: string;
  /**
   * firebase.json-shaped hosting block (rewrites / redirects / headers
   * / cleanUrls / trailingSlash / appAssociation / i18n) translated to
   * the REST `ServingConfig` and baked into the version's `config`.
   * Invalid entries fail fast (nothing uploaded); non-serving keys
   * produce `configWarnings` on the success payload.
   */
  config?: HostingJsonConfig;
  /**
   * Preview-channel id. Omit (or pass `'live'`) to release to the
   * live channel — the existing behavior, unchanged. Any other id is
   * ensured (created with `channelTtl` if absent; 409 = reuse) and
   * the release lands on that channel's URL instead of live.
   */
  channelId?: string;
  /**
   * Channel TTL as a protobuf Duration string (e.g. `'604800s'`).
   * Applies only when the channel is CREATED by this deploy; an
   * existing channel keeps its TTL. Default 7 days.
   */
  channelTtl?: string;
}

export async function deployHostingFiles(
  input: DeployHostingFilesInput,
): Promise<DeployHostingResult> {
  const validation = validateInput(input);
  if (validation) return fail(validation);

  // Translate the firebase.json-shaped hosting block to the REST
  // config BEFORE any network work — a bad rewrite/redirect/header
  // fails fast with nothing created or uploaded.
  const built = buildVersionConfig(input.config);
  if (!built.ok) {
    return fail({ code: 'INVALID_INPUT', message: built.message, recoverable: true });
  }

  // 0. Channel deploys: ensure the preview channel exists BEFORE any
  //    upload work — a bad channel id fails fast with nothing
  //    uploaded. `'live'` is the default channel every site already
  //    has, so it routes through the unchanged live path below.
  const channelId =
    input.channelId && input.channelId !== 'live' ? input.channelId : undefined;
  let channel: ChannelResource | undefined;
  if (channelId) {
    const ensured = await ensureChannel({
      siteId: input.siteId,
      channelId,
      ...(input.channelTtl ? { ttl: input.channelTtl } : {}),
      accessToken: input.accessToken,
    });
    if (ensured.kind === 'network_error') {
      return fail({ code: 'NETWORK_ERROR', message: `network error (ensure channel '${channelId}'): ${ensured.message}`, recoverable: true });
    }
    if (ensured.kind === 'permission_denied') {
      return fail({ code: 'PERMISSION_DENIED', message: ensured.message, recoverable: false });
    }
    if (ensured.kind === 'invalid_id') {
      return fail({ code: 'CHANNEL_FAILED', message: `Hosting rejected channel id '${channelId}': ${ensured.message}`, recoverable: true });
    }
    if (ensured.kind === 'http_error') {
      return fail({ code: 'CHANNEL_FAILED', message: `HTTP ${ensured.status} (ensure channel '${channelId}')${ensured.body ? `: ${truncate(ensured.body, 500)}` : ''}`, recoverable: ensured.status >= 500 });
    }
    channel = ensured.channel;
  }

  // 1. Manifest: { "/path": "<sha256-hex of gzipped bytes>" }
  //    byHash:   { "<sha256-hex>": Uint8Array of gzipped bytes }
  //    Two files with identical content collapse to one upload —
  //    server-side dedup also handles cross-version dedup.
  const manifest: Record<string, string> = {};
  const byHash = new Map<string, Uint8Array>();
  await Promise.all(input.files.map(async (f) => {
    const path = normalizePath(f.path);
    const gz = await gzip(f.bytes);
    const hash = await sha256Hex(gz);
    manifest[path] = hash;
    if (!byHash.has(hash)) byHash.set(hash, gz);
  }));

  const jsonHeaders = {
    Authorization: `Bearer ${input.accessToken}`,
    'Content-Type': 'application/json',
  };

  // 2. Create version. Bake the translated serving config into the body.
  const createUrl = `${HOSTING_API}/sites/${encodeURIComponent(input.siteId)}/versions`;
  const createOut = await safeFetch(createUrl, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ config: built.config }),
  });
  if (createOut.kind !== 'ok') {
    return fail(await translateOutcome(createOut, {
      403: 'PERMISSION_DENIED',
      404: 'SITE_NOT_FOUND',
      default: 'CREATE_VERSION_FAILED',
    }));
  }
  const version = (await createOut.res.json()) as VersionResource;
  const versionName = version.name;

  // 3. Populate files (declare manifest; server returns required-hash list).
  const populateUrl = `${HOSTING_API}/${versionName}:populateFiles`;
  const populateOut = await safeFetch(populateUrl, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ files: manifest }),
  });
  if (populateOut.kind !== 'ok') {
    return fail(await translateOutcome(populateOut, {
      403: 'PERMISSION_DENIED',
      default: 'POPULATE_FAILED',
    }));
  }
  const populate = (await populateOut.res.json()) as PopulateFilesResponse;
  const required = populate.uploadRequiredHashes ?? [];
  const uploadUrl = populate.uploadUrl;

  // 4. Upload each required hash concurrently.
  const CONCURRENCY_LIMIT = 16;
  let uploadedCount = 0;
  let firstError: DeployHostingResult | null = null;
  const octetHeaders = {
    Authorization: `Bearer ${input.accessToken}`,
    'Content-Type': 'application/octet-stream',
  };

  const queue = [...required];
  const worker = async () => {
    while (queue.length > 0 && !firstError) {
      const hash = queue.shift()!;
      const gz = byHash.get(hash);
      if (!gz) {
        firstError = fail({
          code: 'UPLOAD_FAILED',
          message: `Hosting requested unknown hash ${hash}`,
          recoverable: false,
        });
        return;
      }
      const upOut = await safeFetch(`${uploadUrl}/${hash}`, {
        method: 'POST',
        headers: octetHeaders,
        body: gz as BodyInit,
      });
      if (upOut.kind !== 'ok') {
        const errorResult = fail(await translateOutcome(upOut, {
          403: 'PERMISSION_DENIED',
          default: 'UPLOAD_FAILED',
        }, `upload of hash ${hash}`));
        if (!firstError) firstError = errorResult;
        return;
      }
      uploadedCount++;
    }
  };

  if (required.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY_LIMIT, required.length) }, worker),
    );
  }
  if (firstError) return firstError;

  // 5. Finalize. Hosting validates rewrite targets here, not on
  //    create — a 400 that mentions a missing function maps to
  //    REWRITE_TARGET_NOT_FOUND so the caller knows to deploy the
  //    function first.
  const finalizeUrl = `${HOSTING_API}/${versionName}?update_mask=status`;
  const finalizeOut = await safeFetch(finalizeUrl, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ status: 'FINALIZED' }),
  });
  if (finalizeOut.kind !== 'ok') {
    if (finalizeOut.kind === 'http_error' && finalizeOut.res.status === 400) {
      const body = await finalizeOut.res.clone().text().catch(() => '');
      if (looksLikeMissingRewriteTarget(body)) {
        return fail({
          code: 'REWRITE_TARGET_NOT_FOUND',
          message: `Hosting could not resolve a rewrite target. The function named in your rewrites must exist before finalize. ${truncate(body, 400)}`,
          recoverable: true,
        });
      }
    }
    return fail(await translateOutcome(finalizeOut, {
      403: 'PERMISSION_DENIED',
      default: 'FINALIZE_FAILED',
    }));
  }

  // 6. Release. Channel deploys release onto the channel's own
  //    releases collection (api.ts:481-493); live keeps the original
  //    path untouched.
  const releaseUrl = channelId
    ? `${HOSTING_API}/projects/-/sites/${encodeURIComponent(input.siteId)}/channels/${encodeURIComponent(channelId)}/releases?versionName=${encodeURIComponent(versionName)}`
    : `${HOSTING_API}/sites/${encodeURIComponent(input.siteId)}/releases?versionName=${encodeURIComponent(versionName)}`;
  const releaseOut = await safeFetch(releaseUrl, {
    method: 'POST',
    headers: jsonHeaders,
    body: '{}',
  });
  if (releaseOut.kind !== 'ok') {
    return fail(await translateOutcome(releaseOut, {
      403: 'PERMISSION_DENIED',
      default: 'RELEASE_FAILED',
    }));
  }
  const release = (await releaseOut.res.json()) as ReleaseResource;

  return {
    success: true,
    data: {
      siteId: input.siteId,
      versionName,
      releaseName: release.name,
      fileCount: input.files.length,
      uploadedCount,
      hostingUrl: `https://${input.siteId}.web.app`,
      ...(channelId && channel
        ? {
            channelId,
            channelUrl: channel.url,
            ...(channel.expireTime ? { channelExpireTime: channel.expireTime } : {}),
          }
        : {}),
      ...(built.warnings.length > 0 ? { configWarnings: built.warnings } : {}),
    },
  };
}

function validateInput(input: DeployHostingFilesInput): DeployHostingError | null {
  if (!input || typeof input !== 'object') {
    return { code: 'INVALID_INPUT', message: 'input must be an object', recoverable: true };
  }
  if (!input.siteId || typeof input.siteId !== 'string') {
    return { code: 'INVALID_INPUT', message: 'siteId must be a non-empty string', recoverable: true };
  }
  if (!input.accessToken || typeof input.accessToken !== 'string') {
    return { code: 'INVALID_INPUT', message: 'accessToken must be a non-empty string', recoverable: true };
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { code: 'INVALID_INPUT', message: 'files must be a non-empty array', recoverable: true };
  }
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i];
    if (!f || typeof f.path !== 'string' || !f.path) {
      return { code: 'INVALID_INPUT', message: `files[${i}].path must be a non-empty string`, recoverable: true };
    }
    if (!(f.bytes instanceof Uint8Array)) {
      return { code: 'INVALID_INPUT', message: `files[${i}].bytes must be a Uint8Array`, recoverable: true };
    }
  }
  if (input.channelId !== undefined && (typeof input.channelId !== 'string' || !input.channelId)) {
    return { code: 'INVALID_INPUT', message: 'channelId must be a non-empty string if provided', recoverable: true };
  }
  if (input.channelTtl !== undefined && !/^\d+s$/.test(String(input.channelTtl))) {
    return { code: 'INVALID_INPUT', message: "channelTtl must be a protobuf Duration string like '604800s' if provided", recoverable: true };
  }
  if (input.config !== undefined && (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config))) {
    // Per-key validation (rewrites/redirects/headers/scalars) lives in
    // buildVersionConfig — this only rejects the structurally hopeless.
    return { code: 'INVALID_INPUT', message: 'config must be an object (a firebase.json hosting block) if provided', recoverable: true };
  }
  return null;
}

function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  out = out.replace(/\/+/g, '/');
  return out;
}

/**
 * Discriminated outcome of a single REST call. We don't synthesize a
 * `new Response(..., { status: 0 })` for network errors — Bun rejects
 * that, and the tagged shape makes the network-vs-HTTP branch
 * explicit in the call sites that consume it.
 */
type FetchOutcome =
  | { kind: 'ok'; res: Response }
  | { kind: 'http_error'; res: Response }
  | { kind: 'network_error'; message: string };

async function safeFetch(url: string, init: RequestInit): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, init);
    return res.ok ? { kind: 'ok', res } : { kind: 'http_error', res };
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
}

interface HttpMap {
  403?: 'PERMISSION_DENIED';
  404?: 'SITE_NOT_FOUND';
  default: Exclude<HostingErrorCode, 'INVALID_INPUT'>;
}

async function translateOutcome(
  outcome: Exclude<FetchOutcome, { kind: 'ok' }>,
  map: HttpMap,
  context?: string,
): Promise<DeployHostingError> {
  const ctx = context ? ` (${context})` : '';

  if (outcome.kind === 'network_error') {
    return { code: 'NETWORK_ERROR', message: `network error${ctx}: ${outcome.message}`, recoverable: true };
  }

  const res = outcome.res;
  const text = await res.text().catch(() => '');
  const detail = text ? `: ${truncate(text, 500)}` : '';

  if (res.status === 403 && map[403]) {
    return { code: 'PERMISSION_DENIED', message: `Hosting denied the request${ctx} — service account needs roles/firebasehosting.admin${detail}`, recoverable: false };
  }
  if (res.status === 404 && map[404]) {
    return { code: 'SITE_NOT_FOUND', message: `Hosting site not found${ctx}. Visit Firebase Console → Hosting to provision the site, or pass an existing siteId${detail}`, recoverable: true };
  }
  return { code: map.default, message: `HTTP ${res.status}${ctx}${detail}`, recoverable: res.status >= 500 };
}

/**
 * Best-effort discriminator for the rewrite-target-not-found case.
 * Hosting's 400 body when finalize sees a rewrite pointing at a
 * non-existent function looks like:
 *   "Function 'projects/{p}/locations/{r}/functions/{id}' does not exist"
 * Without a stable error code on the wire, we sniff for the phrase.
 * Worst case: a different 400 falls back to FINALIZE_FAILED, which
 * is still actionable.
 */
function looksLikeMissingRewriteTarget(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    (lower.includes('function') && lower.includes('does not exist'))
    || lower.includes('rewrite target')
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function fail(error: DeployHostingError): DeployHostingResult {
  return { success: false, error };
}
