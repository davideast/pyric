/**
 * Hosting preview channels. The Hosting REST API exposes
 *   POST /v1beta1/projects/-/sites/{siteId}/channels?channelId={id}
 * to create a channel (firebase-tools `createChannel`,
 * clones/firebase-tools/src/hosting/api.ts:332-345) and
 *   GET /v1beta1/projects/-/sites/{siteId}/channels/{id}
 * to read one back (`getChannel`, api.ts:274-290). A channel carries
 * its own preview URL (`site--channelId-<hash>.web.app`) and an
 * `expireTime` — both come from the server; we never synthesize the
 * URL hash locally.
 *
 * `ensureChannel` is the idempotent create-or-get used by the deploy
 * path: 409 ALREADY_EXISTS is success (mirrors `ensureHostingSite`
 * in sites.ts), and we re-read the existing channel so callers
 * always get the real `url` + `expireTime`.
 */

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1';

/**
 * Default channel TTL: 7 days, as a protobuf Duration string.
 * Mirrors firebase-tools' DEFAULT_DURATION (7 * Duration.DAY ms,
 * clones/firebase-tools/src/hosting/expireUtils.ts:32) serialized
 * the way createChannel sends it: `${ttlMillis / 1000}s`
 * (clones/firebase-tools/src/hosting/api.ts:340).
 */
export const DEFAULT_CHANNEL_TTL = '604800s';

/** Subset of the Channel resource we consume (api.ts:61-91). */
export interface ChannelResource {
  /** `projects/{p}/sites/{siteId}/channels/{channelId}` */
  name: string;
  /** Preview URL, e.g. `https://site--pr-1-abc123de.web.app`. */
  url: string;
  /** RFC3339 timestamp the channel auto-deletes at. */
  expireTime?: string;
}

export type EnsureChannelResult =
  | { kind: 'created'; channelId: string; channel: ChannelResource }
  | { kind: 'existed'; channelId: string; channel: ChannelResource }
  | { kind: 'invalid_id'; channelId: string; message: string }
  | { kind: 'permission_denied'; message: string }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error'; message: string };

export interface EnsureChannelInput {
  siteId: string;
  /** Channel id (becomes part of `<site>--<channelId>-<hash>.web.app`). */
  channelId: string;
  /**
   * TTL as a protobuf Duration string (e.g. `'604800s'`). Defaults to
   * 7 days. Applied on CREATE only — an existing channel keeps its
   * TTL (firebase-tools PATCHes the ttl of existing channels,
   * api.ts:352-365; deferred here).
   */
  ttl?: string;
  accessToken: string;
}

export async function ensureChannel(input: EnsureChannelInput): Promise<EnsureChannelResult> {
  const base = channelsUrl(input.siteId);
  const createUrl = `${base}?channelId=${encodeURIComponent(input.channelId)}`;
  const headers = {
    Authorization: `Bearer ${input.accessToken}`,
    'Content-Type': 'application/json',
  };
  let res: Response;
  try {
    res = await fetch(createUrl, {
      method: 'POST',
      headers,
      // Body shape pinned by createChannel (api.ts:338-340): `{ ttl }`.
      body: JSON.stringify({ ttl: input.ttl ?? DEFAULT_CHANNEL_TTL }),
    });
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok) {
    const channel = (await res.json()) as ChannelResource;
    return { kind: 'created', channelId: input.channelId, channel };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 409) {
    // ALREADY_EXISTS — idempotent success. Re-read the channel so the
    // caller still gets the real preview url + expireTime.
    return getExistingChannel(input, headers.Authorization);
  }
  if (res.status === 400) {
    return { kind: 'invalid_id', channelId: input.channelId, message: text || 'invalid channel id' };
  }
  if (res.status === 403) {
    return {
      kind: 'permission_denied',
      message: `Hosting denied channel creation — service account needs roles/firebasehosting.admin: ${text}`,
    };
  }
  return { kind: 'http_error', status: res.status, body: text };
}

async function getExistingChannel(
  input: EnsureChannelInput,
  authorization: string,
): Promise<EnsureChannelResult> {
  // GET /projects/-/sites/{site}/channels/{channelId} (api.ts:274-290).
  const url = `${channelsUrl(input.siteId)}/${encodeURIComponent(input.channelId)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: authorization } });
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok) {
    const channel = (await res.json()) as ChannelResource;
    return { kind: 'existed', channelId: input.channelId, channel };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 403) {
    return {
      kind: 'permission_denied',
      message: `Hosting denied channel read — service account needs roles/firebasehosting.admin: ${text}`,
    };
  }
  return { kind: 'http_error', status: res.status, body: text };
}

function channelsUrl(siteId: string): string {
  // Channels live under the project-scoped collection; `-` lets the
  // server infer the project from the (globally unique) site id —
  // same convention firebase-tools uses (api.ts:339).
  return `${HOSTING_API}/projects/-/sites/${encodeURIComponent(siteId)}/channels`;
}

// ─── CLI sugar: branch-derived channel ids + TTL flag parsing ────────

/**
 * Sanitize a git branch name into a Hosting channel id:
 * lowercase, `[a-z0-9-]` only (every other char becomes `-`), runs
 * of `-` collapsed, trimmed to 63 chars, leading/trailing `-`
 * stripped. Returns `''` when nothing survives (caller must treat
 * that as "no derivable id").
 */
export function sanitizeChannelId(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
}

export type ParsedChannelTtl =
  | { ok: true; ttl: string }
  | { ok: false; message: string };

const DURATION_REGEX = /^(\d+)([hdm])$/;
const SECONDS: Record<string, number> = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Parse a `--channel-ttl` flag (`30m` / `12h` / `7d`) into a protobuf
 * Duration string. Grammar + 30d cap mirror firebase-tools'
 * `calculateChannelExpireTTL` (clones/firebase-tools/src/hosting/
 * expireUtils.ts:7,27,41-54).
 */
export function parseChannelTtl(flag: string): ParsedChannelTtl {
  const match = DURATION_REGEX.exec(flag);
  if (!match) {
    return { ok: false, message: `--channel-ttl must be a duration like 30m, 12h or 7d (got '${flag}')` };
  }
  const seconds = parseInt(match[1]!, 10) * SECONDS[match[2]!]!;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, message: `failed to parse --channel-ttl '${flag}'` };
  }
  if (seconds > MAX_TTL_SECONDS) {
    return { ok: false, message: `--channel-ttl may not exceed 30d (got '${flag}')` };
  }
  return { ok: true, ttl: `${seconds}s` };
}
