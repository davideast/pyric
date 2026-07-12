/**
 * In-process session store for `firestore_discover_paths` continuations.
 *
 * Phase 3.3 locked the session API: the agent receives an opaque
 * `continuation` token between batches and the server holds the
 * partial-schema state. This module owns the storage layer; Item 4.2
 * wires it into the crawler.
 *
 * Hard caps (per prerequisite 0.G — bounded session memory):
 *   - `maxSessions`        = 8       — total live sessions
 *   - `maxSessionBytes`    = 32 MB   — per-session payload (well above
 *                                      Phase 0.4's 11.64 MB worst case)
 *   - `ttlMs`              = 30 min  — idle TTL (Phase 3.3 lock)
 *
 * Token format: `disc_` + base64url(16-byte ULID). ULID gives natural
 * monotonic ordering (timestamp-prefixed) and avoids a runtime
 * dependency on the `ulid` package.
 *
 * Error model — never throws on expected paths (per Item 4 acceptance
 * criteria). Returns `{ ok: false, error: { code, message, recoveryHint } }`:
 *   - `SESSION_EXPIRED`        — token unknown OR past TTL (per 0.C)
 *   - `SESSION_EVICTED`        — token was capacity-evicted by an LRU
 *                                bump from a concurrent agent (per 0.G)
 *   - `SESSION_PAYLOAD_TOO_LARGE` — state would exceed `maxSessionBytes`
 *   - `SESSION_MALFORMED_TOKEN`   — wrong prefix or undecodable b64
 */
'use strict';

/**
 * Default RNG — Web Crypto's `getRandomValues`. Works in modern
 * browsers AND Node 19+ (webcrypto on globalThis) AND Bun, so this
 * module evaluates cleanly in any environment without a top-level
 * `node:crypto` import.
 *
 * Tests + Node consumers that want a deterministic seam can still
 * override via `SessionStoreOptions.randomBytes`.
 */
function defaultRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

// ─── Defaults (per prerequisite 0.G + Phase 3.3) ──────────────────────────

export const DEFAULT_MAX_SESSIONS = 8;
export const DEFAULT_MAX_SESSION_BYTES = 32 * 1024 * 1024; // 32 MB
export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min idle
/**
 * How many recently-evicted tokens to remember so a returning agent can
 * be told *why* their session is gone (`SESSION_EVICTED`) rather than
 * the generic `SESSION_EXPIRED`. Bounded ring buffer; older entries get
 * overwritten and degrade silently to `SESSION_EXPIRED`.
 */
const DEFAULT_EVICTION_LOG_SIZE = 64;

const TOKEN_PREFIX = 'disc_';

// ─── Types ────────────────────────────────────────────────────────────────

export type SessionErrorCode =
  | 'SESSION_EXPIRED'
  | 'SESSION_EVICTED'
  | 'SESSION_PAYLOAD_TOO_LARGE'
  | 'SESSION_MALFORMED_TOKEN';

export interface SessionError {
  code: SessionErrorCode;
  message: string;
  recoveryHint: string;
}

/**
 * A live session record. `state` is opaque to the store — Item 4.2 will
 * instantiate `SessionStore` with the concrete crawler-state type.
 */
export interface SessionRecord<TState> {
  /** Raw ULID — internal id; not the token surfaced to agents. */
  readonly id: string;
  /** Opaque continuation handle: `disc_<base64url-ulid>`. */
  readonly token: string;
  readonly createdAt: number;
  /** Last get/update; drives both LRU eviction and TTL. */
  lastAccessedAt: number;
  /** Caller-reported payload size for byte-cap enforcement. */
  bytes: number;
  state: TState;
}

export interface SessionStoreOptions {
  maxSessions?: number;
  maxSessionBytes?: number;
  ttlMs?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomBytes`. */
  randomBytes?: (n: number) => Uint8Array;
  evictionLogSize?: number;
}

/** Discriminated-union result so callers don't have to try/catch. */
export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionError };

// ─── ULID + token codec ───────────────────────────────────────────────────

/**
 * 16-byte ULID: 6 bytes big-endian ms timestamp, 10 bytes randomness.
 * Sortable by creation time, collision-free at 80 bits randomness.
 */
function generateUlidBytes(now: number, rand: (n: number) => Uint8Array): Uint8Array {
  const bytes = new Uint8Array(16);
  let ts = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  const r = rand(10);
  bytes.set(r, 6);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Encode a 16-byte ULID into a `disc_<base64url>` token. Internal — used
 * by `SessionStore.create`.
 */
export function encodeToken(ulidBytes: Uint8Array): string {
  if (ulidBytes.length !== 16) {
    throw new Error(`encodeToken: expected 16-byte ULID, got ${ulidBytes.length}`);
  }
  return TOKEN_PREFIX + bytesToBase64Url(ulidBytes);
}

/**
 * Decode a `disc_<base64url>` token. Returns `null` on any malformation
 * — caller maps null to `SESSION_MALFORMED_TOKEN`.
 */
export function decodeToken(token: string): { id: string } | null {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const tail = token.slice(TOKEN_PREFIX.length);
  if (tail.length === 0) return null;
  const bytes = base64UrlToBytes(tail);
  if (bytes === null || bytes.length !== 16) return null;
  return { id: bytesToHex(bytes) };
}

// ─── Session store ────────────────────────────────────────────────────────

/**
 * In-process LRU session store with TTL sweep and per-session byte cap.
 *
 * Eviction policy:
 *   1. On every `create`/`get`/`update`, sweep TTL-expired sessions first.
 *      Their tokens land in the eviction log as `SESSION_EXPIRED`.
 *   2. If `create` would exceed `maxSessions`, evict the LRU
 *      (oldest-by-`lastAccessedAt`). Its token lands in the eviction log
 *      as `SESSION_EVICTED` so the displaced agent gets a meaningful
 *      error on its next call.
 *   3. `update` rejects with `SESSION_PAYLOAD_TOO_LARGE` if the new
 *      `bytes` exceeds `maxSessionBytes` (per-session cap, not aggregate).
 *
 * The eviction log is a bounded ring buffer; once it overflows, evicted
 * tokens degrade silently to `SESSION_EXPIRED` (still actionable — the
 * recoveryHint is the same: re-issue without continuation).
 */
export class SessionStore<TState> {
  private readonly maxSessions: number;
  private readonly maxSessionBytes: number;
  private readonly ttlMs: number;
  private readonly evictionLogSize: number;
  private readonly now: () => number;
  private readonly rand: (n: number) => Uint8Array;

  private readonly sessions = new Map<string, SessionRecord<TState>>();
  /** id → eviction reason. Bounded — see `recordEviction`. */
  private readonly evictionLog = new Map<string, SessionErrorCode>();

  constructor(opts: SessionStoreOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxSessionBytes = opts.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.evictionLogSize = opts.evictionLogSize ?? DEFAULT_EVICTION_LOG_SIZE;
    this.now = opts.now ?? Date.now;
    this.rand = opts.randomBytes ?? defaultRandomBytes;

    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new RangeError(
        `SessionStore: maxSessions must be a positive integer, got ${this.maxSessions}`,
      );
    }
    if (!Number.isInteger(this.maxSessionBytes) || this.maxSessionBytes < 1) {
      throw new RangeError(
        `SessionStore: maxSessionBytes must be a positive integer, got ${this.maxSessionBytes}`,
      );
    }
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new RangeError(
        `SessionStore: ttlMs must be a positive integer, got ${this.ttlMs}`,
      );
    }
  }

  /** Live session count. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Create a new session. Always succeeds unless `bytes` exceeds the
   * per-session byte cap. On cap-hit, evicts the LRU session — the
   * displaced token will report `SESSION_EVICTED` on its next access.
   */
  create(state: TState, bytes: number): SessionResult<SessionRecord<TState>> {
    if (bytes > this.maxSessionBytes) {
      return {
        ok: false,
        error: {
          code: 'SESSION_PAYLOAD_TOO_LARGE',
          message: `Session payload (${bytes} bytes) exceeds cap (${this.maxSessionBytes} bytes)`,
          recoveryHint:
            'Reduce per-batch result size (lower maxSamples or rootFilter to a smaller subtree)',
        },
      };
    }
    const now = this.now();
    this.sweepExpired(now);
    if (this.sessions.size >= this.maxSessions) {
      this.evictLru();
    }
    const ulidBytes = generateUlidBytes(now, this.rand);
    const id = bytesToHex(ulidBytes);
    const token = encodeToken(ulidBytes);
    const record: SessionRecord<TState> = {
      id,
      token,
      createdAt: now,
      lastAccessedAt: now,
      bytes,
      state,
    };
    this.sessions.set(id, record);
    return { ok: true, value: record };
  }

  /**
   * Look up a session by token. Touches `lastAccessedAt` on success so
   * subsequent reads keep the session warm. On expired/malformed/evicted
   * tokens returns the appropriate structured error.
   */
  get(token: string): SessionResult<SessionRecord<TState>> {
    const decoded = decodeToken(token);
    if (decoded === null) {
      return {
        ok: false,
        error: {
          code: 'SESSION_MALFORMED_TOKEN',
          message: `Continuation token is malformed (expected ${TOKEN_PREFIX}<base64url>)`,
          recoveryHint: 'Re-issue without continuation to start fresh',
        },
      };
    }
    const now = this.now();
    this.sweepExpired(now);
    const record = this.sessions.get(decoded.id);
    if (!record) return this.lookupEvicted(decoded.id);
    record.lastAccessedAt = now;
    return { ok: true, value: record };
  }

  /**
   * Replace the state of an existing session. Same lookup/error model
   * as `get`, plus per-session-bytes enforcement on the new payload.
   */
  update(token: string, state: TState, bytes: number): SessionResult<SessionRecord<TState>> {
    const lookup = this.get(token);
    if (!lookup.ok) return lookup;
    if (bytes > this.maxSessionBytes) {
      return {
        ok: false,
        error: {
          code: 'SESSION_PAYLOAD_TOO_LARGE',
          message: `Updated session payload (${bytes} bytes) exceeds cap (${this.maxSessionBytes} bytes)`,
          recoveryHint:
            'Crawl produced more state than the per-session cap allows; surface partial result and stop',
        },
      };
    }
    const record = lookup.value;
    record.state = state;
    record.bytes = bytes;
    // `get` already touched lastAccessedAt; no need to re-stamp.
    return { ok: true, value: record };
  }

  /** Best-effort delete; returns true if a session was removed. */
  delete(token: string): boolean {
    const decoded = decodeToken(token);
    if (decoded === null) return false;
    return this.sessions.delete(decoded.id);
  }

  /**
   * Drop sessions whose `lastAccessedAt + ttlMs` is in the past.
   * Returns the number of sessions evicted. Public for tests +
   * future scheduled-sweep usage; `create`/`get`/`update` all call it
   * lazily so callers don't normally need to.
   */
  sweepExpired(now: number = this.now()): number {
    let count = 0;
    const cutoff = now - this.ttlMs;
    for (const [id, record] of this.sessions) {
      if (record.lastAccessedAt < cutoff) {
        this.sessions.delete(id);
        this.recordEviction(id, 'SESSION_EXPIRED');
        count++;
      }
    }
    return count;
  }

  // ─── internals ───────────────────────────────────────────────────────

  private evictLru(): void {
    let oldestId: string | null = null;
    let oldestTs = Infinity;
    for (const [id, record] of this.sessions) {
      if (record.lastAccessedAt < oldestTs) {
        oldestTs = record.lastAccessedAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) {
      this.sessions.delete(oldestId);
      this.recordEviction(oldestId, 'SESSION_EVICTED');
    }
  }

  private recordEviction(id: string, reason: SessionErrorCode): void {
    if (this.evictionLog.size >= this.evictionLogSize) {
      // Drop the oldest entry — Map iteration is insertion-ordered.
      const firstKey = this.evictionLog.keys().next().value;
      if (firstKey !== undefined) this.evictionLog.delete(firstKey);
    }
    this.evictionLog.set(id, reason);
  }

  private lookupEvicted(id: string): SessionResult<SessionRecord<TState>> {
    const reason = this.evictionLog.get(id);
    if (reason === 'SESSION_EVICTED') {
      return {
        ok: false,
        error: {
          code: 'SESSION_EVICTED',
          message:
            'Continuation was evicted because the session-store capacity is full (a concurrent agent bumped you).',
          recoveryHint:
            'Retry the discover_paths call without the continuation; consider serializing concurrent crawls',
        },
      };
    }
    // SESSION_EXPIRED covers both TTL-expired and never-existed tokens.
    // Both surface the same recovery action: re-issue without continuation.
    return {
      ok: false,
      error: {
        code: 'SESSION_EXPIRED',
        message:
          'Continuation is unknown or past the 30-minute TTL. The server has discarded the partial state.',
        recoveryHint: 'Re-issue without continuation to start fresh',
      },
    };
  }
}
