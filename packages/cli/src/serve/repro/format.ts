/**
 * The repro file: what the Node host recorded, in a form another machine can
 * replay.
 *
 * A repro holds a starting state and the operation log that followed it. The
 * starting state is a checkpoint (the same value `checkpoint` and `exportState`
 * write) with Storage bytes inline, plus each named RTDB instance's tree, the
 * rules every service and instance enforced, the identity each port was signed
 * in as, the listeners each port held, and the app configuration. The log is
 * the protocol frames each port sent and received, in the order the host saw
 * them, with rules deploys and out-of-band calls between them.
 *
 * Secrets never enter the file. A JSON Web Token keeps its header and claims
 * and loses its signature, and a private key or service account record is
 * replaced by a marker. {@link redactSecrets} applies both rules to every value
 * the file carries.
 */
import { z } from 'zod';
import type { Checkpoint } from 'pyric/sandbox/checkpoints';
import type { InboundMessage, OutboundMessage } from '../worker/protocol.js';

export const REPRO_SCHEMA = 'pyric.repro.v1' as const;

/** The ruleset one RTDB instance enforced, keyed by instance name. */
export type ReproDatabaseRules = Record<string, { rules: Record<string, unknown> } | null>;

/** The identity a port was signed in as when the log starts. */
export interface ReproPortSession {
  uid: string;
  tenantId: string | null;
}

/** Everything the host held when the recorded log starts. */
export interface ReproBase {
  /** When the starting state was read, in milliseconds since the epoch. */
  at: number;
  /** Firestore, the default RTDB instance, Storage, Auth, rules and clock. */
  checkpoint: Checkpoint;
  /** Each named RTDB instance's tree; the default instance is in the checkpoint. */
  databaseInstances: Record<string, unknown>;
  rules: {
    firestore: string | null;
    /** Keyed by instance name; `defaultInstance` names the default one. */
    database: ReproDatabaseRules;
    storage: string | null;
  };
  /** The instance `getDatabase(app)` selects. */
  defaultInstance: string;
  /** Whether instances without rules allow every request (`--permissive`). */
  permissive: boolean;
  /** The Firebase options the first app port sent, when one had. */
  appOptions: Record<string, unknown> | null;
  /** Ports signed in when the log starts, keyed by client session id. */
  sessions: Record<string, ReproPortSession>;
  /** Listener registrations still open when the log starts, by client session id. */
  subscriptions: Record<string, InboundMessage[]>;
}

/** One record in the operation log. */
export type ReproEntry =
  /** A frame a port sent: an operation, a listener registration, an unsubscribe. */
  | { kind: 'in'; at: number; session: string; frame: InboundMessage }
  /** A frame the host sent a port: an operation result or a listener event. */
  | { kind: 'out'; at: number; session: string; frame: OutboundMessage }
  /** A rules deploy from the project's rules files. */
  | { kind: 'rules'; at: number; service: 'firestore' | 'database' | 'storage'; instance?: string; source: unknown }
  /** A command or MCP method call that changed state outside any port. Replay cannot run it. */
  | { kind: 'external'; at: number; source: 'command'; name: string };

export interface ReproFile {
  schema: typeof REPRO_SCHEMA;
  createdAt: string;
  /** The `@pyric/cli` version that recorded it. */
  recordedBy: string;
  /** True when older entries were dropped to keep the log bounded. */
  truncated: boolean;
  base: ReproBase;
  entries: ReproEntry[];
}

const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('in'), at: z.number(), session: z.string(), frame: z.object({ t: z.string() }).passthrough() }),
  z.object({ kind: z.literal('out'), at: z.number(), session: z.string(), frame: z.object({ t: z.string() }).passthrough() }),
  z.object({
    kind: z.literal('rules'), at: z.number(),
    service: z.enum(['firestore', 'database', 'storage']), instance: z.string().optional(), source: z.unknown(),
  }),
  z.object({ kind: z.literal('external'), at: z.number(), source: z.literal('command'), name: z.string() }),
]);

const reproSchema = z.object({
  schema: z.literal(REPRO_SCHEMA),
  createdAt: z.string(),
  recordedBy: z.string(),
  truncated: z.boolean(),
  base: z.object({
    at: z.number(),
    checkpoint: z.object({ format: z.string(), state: z.unknown() }).passthrough(),
    databaseInstances: z.record(z.unknown()),
    rules: z.object({
      firestore: z.string().nullable(),
      database: z.record(z.object({ rules: z.record(z.unknown()) }).nullable()),
      storage: z.string().nullable(),
    }),
    defaultInstance: z.string(),
    permissive: z.boolean(),
    appOptions: z.record(z.unknown()).nullable(),
    sessions: z.record(z.object({ uid: z.string(), tenantId: z.string().nullable() })),
    subscriptions: z.record(z.array(z.object({ t: z.literal('sub') }).passthrough())),
  }),
  entries: z.array(entrySchema),
});

/** Read a repro file's JSON value, refusing one this version cannot replay. */
export function parseRepro(value: unknown): ReproFile {
  const result = reproSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.join('.') || '(root)';
    throw new Error(`Not a ${REPRO_SCHEMA} file: ${where}: ${issue.message}`);
  }
  return result.data as unknown as ReproFile;
}

// ─── Secrets ───────────────────────────────────────────────────────────────

/** The marker a redacted JSON Web Token leaves: its header and claims, no signature. */
export const REDACTED_JWT_KEY = '__redactedJwt';
/** The marker a removed secret leaves. */
export const REDACTED_SECRET = '[redacted]';

const JWT_PATTERN = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** Keys whose value is a credential with no claims to keep. */
const SECRET_KEYS = new Set(['private_key', 'privateKey', 'private_key_id', 'privateKeyId', 'client_secret', 'clientSecret']);

function decodeBase64Url(segment: string): string {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = padded.length % 4;
  const base64 = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The header and claims of a JSON Web Token, or null when the string is not one. */
export function jwtParts(value: string): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
  const looksLikeJwt = JWT_PATTERN.test(value);
  if (!looksLikeJwt) return null;
  const [header, claims] = value.split('.');
  try {
    const parsedHeader: unknown = JSON.parse(decodeBase64Url(header));
    const parsedClaims: unknown = JSON.parse(decodeBase64Url(claims));
    const isToken = isPlainObject(parsedHeader) && typeof parsedHeader.alg === 'string' && isPlainObject(parsedClaims);
    return isToken ? { header: parsedHeader, claims: parsedClaims } : null;
  } catch {
    return null;
  }
}

/**
 * Re-encode a redacted token as an unsigned JSON Web Token. The sandbox reads
 * a token's claims and checks no signature, so the token works on replay.
 */
export function unsignedJwt(redacted: { header: Record<string, unknown>; claims: Record<string, unknown> }): string {
  return `${encodeBase64Url(JSON.stringify(redacted.header))}.${encodeBase64Url(JSON.stringify(redacted.claims))}.`;
}

/** True when an object is a Google service account key file. */
function isServiceAccount(value: Record<string, unknown>): boolean {
  return value.type === 'service_account' || ('client_email' in value && 'private_key' in value);
}

/**
 * Copy a JSON value with its secrets removed: every JSON Web Token becomes its
 * header and claims, every private key or service account record becomes
 * {@link REDACTED_SECRET}.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    const isPrivateKey = PRIVATE_KEY_PATTERN.test(value);
    if (isPrivateKey) return REDACTED_SECRET;
    const token = jwtParts(value);
    return token === null ? value : { [REDACTED_JWT_KEY]: token };
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isPlainObject(value)) return value;
  if (isServiceAccount(value)) return REDACTED_SECRET;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = SECRET_KEYS.has(key) ? REDACTED_SECRET : redactSecrets(child);
  }
  return copy;
}

/** Reverse the token redaction for replay: each redacted token becomes an unsigned one. */
export function restoreRedactedTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreRedactedTokens);
  if (!isPlainObject(value)) return value;
  const redacted = value[REDACTED_JWT_KEY];
  const isRedactedToken = Object.keys(value).length === 1 && isPlainObject(redacted)
    && isPlainObject(redacted.header) && isPlainObject(redacted.claims);
  if (isRedactedToken) {
    return unsignedJwt(redacted as { header: Record<string, unknown>; claims: Record<string, unknown> });
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = restoreRedactedTokens(child);
  return copy;
}
