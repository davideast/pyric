// Fills a recording's placeholders when the replay server answers: target
// ids from the request, read and commit times from a clock that only moves
// forward, opaque tokens, and ID tokens shaped like Firebase Auth's.
import { placeholderName, type Json, type JsonObject } from './format.ts';

/** Strictly increasing RFC 3339 times with microseconds, as Firestore sends. */
export class ReplayClock {
  private last = 0;

  next(): string {
    const micros = Math.max(Date.now() * 1000, this.last + 1);
    this.last = micros;
    const millis = Math.floor(micros / 1000);
    const iso = new Date(millis).toISOString().replace(/\.\d{3}Z$/, '');
    const fraction = String(micros % 1_000_000).padStart(6, '0');
    return `${iso}.${fraction}Z`;
  }
}

/** What one answer needs to fill its placeholders. */
export interface FillContext {
  clock: ReplayClock;
  project: string;
  targetId?: number;
  /** The commit time of this answer, shared by every write result in it. */
  commitTime?: string;
  tokens: ReplayTokens;
  /** The document ids the Admin SDK picked for `add`, by the name of the `autoId` placeholder that matched each. */
  autoIds?: ReadonlyMap<string, string>;
}

/** Opaque tokens and the uid each minted ID token stands for. */
export class ReplayTokens {
  private count = 0;
  private readonly users = new Map<string, string>();

  opaque(kind: string): string {
    this.count += 1;
    return Buffer.from(`replay-${kind}-${this.count}`).toString('base64');
  }

  /**
   * An ID token with Firebase Auth's claims for a test project, signed by no
   * one. An anonymous token also carries `provider_id: "anonymous"`, as the
   * ones capture A's clients got from production do. An `unsigned` token
   * has the header `alg: none` and no signature, as the Auth emulator issues
   * one: firebase-admin's `verifyIdToken` under `FIREBASE_AUTH_EMULATOR_HOST`
   * accepts only that shape, so a page whose backend checks its token there
   * signs in with one.
   */
  mintIdToken(project: string, fields: JsonObject): string {
    const uid = String(fields.uid);
    const now = Math.floor(Date.now() / 1000);
    const provider = typeof fields.provider === 'string' ? fields.provider : 'password';
    const email = typeof fields.email === 'string' ? fields.email : undefined;
    const isAnonymous = provider === 'anonymous';
    const claims = {
      ...(isAnonymous ? { provider_id: provider } : {}),
      iss: `https://securetoken.google.com/${project}`,
      aud: project,
      auth_time: now,
      user_id: uid,
      sub: uid,
      iat: now,
      exp: now + 3600,
      ...(email ? { email, email_verified: false } : {}),
      firebase: { identities: email ? { email: [email] } : {}, sign_in_provider: provider },
    };
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const isUnsigned = fields.unsigned === true;
    const header = isUnsigned ? { alg: 'none', typ: 'JWT' } : { alg: 'RS256', kid: 'replay', typ: 'JWT' };
    const signature = isUnsigned ? '' : Buffer.from('replay').toString('base64url');
    const token = `${segment(header)}.${segment(claims)}.${signature}`;
    this.users.set(token, uid);
    return token;
  }

  /** The uid a minted ID token stands for, or null for no token or one this server did not mint. */
  uidOf(token: string | undefined): string | null {
    return token ? this.users.get(token) ?? null : null;
  }
}

/** A copy of `value` with every placeholder filled. */
export function fill(value: Json, context: FillContext): Json {
  const name = placeholderName(value);
  if (name !== null) return fillPlaceholder(name, value as JsonObject, context);
  if (Array.isArray(value)) return value.map((item) => fill(item, context));
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, context)]));
}

function fillPlaceholder(name: string, value: JsonObject, context: FillContext): Json {
  switch (name) {
    case 'targetId':
      if (context.targetId === undefined) throw new Error('replay: a targetId placeholder outside a Listen answer');
      return context.targetId;
    case 'readTime':
      return context.clock.next();
    case 'commitTime':
      context.commitTime ??= context.clock.next();
      return context.commitTime;
    case 'resumeToken':
      return context.tokens.opaque('resume');
    case 'refreshToken':
      return context.tokens.opaque('refresh');
    case 'idToken':
      return context.tokens.mintIdToken(context.project, value);
    case 'autoId':
      return autoIdName(value, context.autoIds);
    default:
      throw new Error(`replay: the ${name} placeholder only matches requests`);
  }
}

/** An `autoId` placeholder's document name: its parent and the id kept under its name. */
function autoIdName(placeholder: JsonObject, autoIds: ReadonlyMap<string, string> | undefined): string {
  const id = autoIds?.get(String(placeholder.name));
  if (id === undefined) throw new Error(`replay: an answer names the document id ${String(placeholder.name)}, which no request has picked`);
  return `${String(placeholder.parent)}/${id}`;
}

/**
 * Whether a request value matches a recorded one, where `{ "$": "any" }`
 * matches everything. With `tokens`, `{ "$": "idToken", "uid": "<uid>" }`
 * matches an ID token this server minted for that uid, so two accounts'
 * Auth calls each get their own answer.
 */
export function matches(recorded: Json | undefined, actual: Json | undefined, tokens?: ReplayTokens): boolean {
  const name = placeholderName(recorded);
  if (name === 'any') return actual !== undefined;
  if (name === 'idToken' && tokens) return typeof actual === 'string' && tokens.uidOf(actual) === (recorded as JsonObject).uid;
  if (Array.isArray(recorded)) {
    return Array.isArray(actual) && actual.length === recorded.length && recorded.every((item, index) => matches(item, actual[index], tokens));
  }
  const isObject = typeof recorded === 'object' && recorded !== null;
  if (!isObject) return recorded === actual;
  const isActualObject = typeof actual === 'object' && actual !== null && !Array.isArray(actual);
  if (!isActualObject) return false;
  const recordedKeys = Object.keys(recorded).sort();
  const actualKeys = Object.keys(actual).sort();
  const sameKeys = recordedKeys.length === actualKeys.length && recordedKeys.every((key, index) => key === actualKeys[index]);
  return sameKeys && recordedKeys.every((key) => matches((recorded as JsonObject)[key], (actual as JsonObject)[key], tokens));
}
