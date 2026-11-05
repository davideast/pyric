// The recorded-exchange file a replay server answers from. A file holds
// request shapes and the answers production gave, with test-project values
// only: every token, timestamp the server picks, and stream id is a
// placeholder the replay server fills in when it answers.
import { readFileSync } from 'node:fs';

export const FORMAT = 'pyric-replay/1';

/** JSON as the wire carries it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * A value the replay server fills in when it answers, written as
 * `{ "$": "<name>" }`. `any` matches every request value. `idToken` is minted
 * from its `uid`, `email` and `provider` fields; in an Auth request it matches
 * a token this server minted for its `uid`. `host`, `session` and
 * `serverTime` fill an RTDB handshake: the host the client connected to, a
 * fresh session id, and the server's clock in milliseconds. `pushId` stands
 * for a push key the client picks: `{ "$": "pushId", "name": "<name>",
 * "parent": "<path>" }` matches the path `<parent>/<key>` in an RTDB request
 * and keeps the client's key under its name; in an answer it is filled with
 * that path, or with the key alone when it has no `parent`. In an answer an
 * object key `$pushId:<name>` is filled with the key too; an RTDB key cannot
 * hold `$`, so it never names a real child.
 */
export const PLACEHOLDERS = ['any', 'targetId', 'readTime', 'resumeToken', 'commitTime', 'idToken', 'refreshToken', 'host', 'session', 'serverTime', 'pushId'] as const;
export type PlaceholderName = (typeof PLACEHOLDERS)[number];

/** A batch of Listen responses for one target. `after` names the write exchange whose answer releases it. */
export interface ListenBatch {
  after?: string;
  messages: JsonObject[];
}

/** One Listen target as the SDK adds it, and what production sent for it. */
export interface ListenExchange {
  kind: 'listen';
  id: string;
  /** The uid the stream ran as, null for no user. Absent matches any. */
  as?: string | null;
  /** `addTarget` without `targetId`, `resumeToken`, `readTime`, `expectedCount` or `once`. */
  target: JsonObject;
  batches: ListenBatch[];
}

/** One message on the Write stream and production's answer: a response or a stream error. */
export interface WriteExchange {
  kind: 'write';
  id: string;
  as?: string | null;
  writes: Json[];
  response?: JsonObject;
  error?: { code: number; status: string; message: string };
}

/** One Auth REST call and its answer. `path` has no query string: the API key is never recorded. */
export interface AuthExchange {
  kind: 'auth';
  id: string;
  request: { method: string; host: string; path: string; body?: JsonObject };
  response: { status: number; body: JsonObject };
}

/**
 * One RTDB data message on a WebSocket connection and production's answer.
 * `request` is the message's `a` and `b`, without its request number `r`; an
 * exchange with no request is the handshake a connection to `instance` gets
 * when it opens. `events` are whole frames sent before `reply`, which is the
 * `b` of the response to the request. `later` holds the frames a listen
 * (`q`) gets after its reply: each batch goes out on the listening
 * connection when the exchange its `after` names is answered, on any
 * connection. An onDisconnect write (`o`, `om`) counts as answered when its
 * connection closes, as production runs it then.
 */
export interface RtdbExchange {
  kind: 'rtdb';
  id: string;
  /** The database instance, the `ns` the client connects with. */
  instance: string;
  /** The uid the connection authenticated as, null for none. Absent matches any. */
  as?: string | null;
  request?: { a: string; b: Json };
  events?: JsonObject[];
  reply?: { s: string; d: Json };
  later?: RtdbBatch[];
}

/** Frames a listening connection gets once the exchange `after` names is answered. */
export interface RtdbBatch {
  after: string;
  events: JsonObject[];
}

export type Exchange = ListenExchange | WriteExchange | AuthExchange | RtdbExchange;

export interface Recording {
  format: typeof FORMAT;
  /** The test project the exchanges came from. Every document name sits under it. */
  project: string;
  /** Where the exchanges came from: `hand-written from the SDK wire format`, or the recorder's run. */
  source: string;
  exchanges: Exchange[];
}

/** The placeholder a value names, or null for a plain value. */
export function placeholderName(value: Json | undefined): PlaceholderName | null {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject) return null;
  const name = (value as JsonObject).$;
  return typeof name === 'string' && (PLACEHOLDERS as readonly string[]).includes(name) ? (name as PlaceholderName) : null;
}

export function readRecording(path: string): Recording {
  const recording = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  assertShapesOnly(recording);
  return recording;
}

/** Strings that are credentials or server-issued secrets, never test values. */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'a JWT', pattern: /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/ },
  { name: 'a Google API key', pattern: /AIza[\w-]{30,}/ },
  { name: 'a bearer credential', pattern: /^Bearer\s/i },
  { name: 'a Google OAuth token', pattern: /ya29\.[\w-]+/ },
  { name: 'a refresh token', pattern: /^AMf-v[\w-]{20,}/ },
];

/** Keys whose values are server-issued and must be placeholders. */
const PLACEHOLDER_KEYS: Record<string, PlaceholderName[]> = {
  idToken: ['idToken', 'any'],
  refreshToken: ['refreshToken', 'any'],
  resumeToken: ['resumeToken'],
  readTime: ['readTime'],
  commitTime: ['commitTime'],
  password: ['any'],
  id_token: ['idToken'],
  access_token: ['idToken'],
  refresh_token: ['refreshToken', 'any'],
  cred: ['idToken', 'any'],
};

/**
 * Throws unless the recording holds shapes and test-project values only: the
 * format is known, no credential appears, server-issued values are
 * placeholders, every document name is under the recording's project, and
 * every RTDB instance is one of the project's.
 */
export function assertShapesOnly(recording: Recording): void {
  if (recording.format !== FORMAT) throw new Error(`replay: format is ${String(recording.format)}, expected ${FORMAT}`);
  if (!/^[a-z0-9-]+$/.test(recording.project)) throw new Error(`replay: project ${recording.project} is not a project id`);
  const ids = new Set<string>();
  for (const exchange of recording.exchanges) {
    if (ids.has(exchange.id)) throw new Error(`replay: exchange id ${exchange.id} appears twice`);
    ids.add(exchange.id);
  }
  walk(recording.exchanges as unknown as Json, `exchanges`, (path, key, value) => checkValue(recording.project, path, key, value));
  recording.exchanges.forEach((exchange, index) => {
    if (exchange.kind === 'rtdb') checkRtdb(recording.project, `exchanges[${index}]`, exchange, ids);
  });
}

/** The placeholder each handshake field must be: production's values name its own hosts and sessions. */
const HANDSHAKE_PLACEHOLDERS: Record<string, PlaceholderName> = { h: 'host', s: 'session', ts: 'serverTime' };

/**
 * Throws unless an RTDB exchange's instance is the project's, its handshakes
 * hold placeholders only, and every `after` names an exchange in the recording.
 */
function checkRtdb(project: string, path: string, exchange: RtdbExchange, ids: Set<string>): void {
  const isProjectInstance = /^[a-z0-9-]+$/.test(exchange.instance) && exchange.instance.startsWith(`${project}-`);
  if (!isProjectInstance) throw new Error(`replay: ${path}.instance names ${exchange.instance}, outside project ${project}`);
  (exchange.later ?? []).forEach((batch, index) => {
    if (!ids.has(batch.after)) throw new Error(`replay: ${path}.later[${index}].after names ${batch.after}, which no exchange is`);
  });
  (exchange.events ?? []).forEach((event, index) => {
    const control = event.t === 'c' ? (event.d as JsonObject | undefined) : undefined;
    if (control?.t !== 'h') return;
    const handshake = (control.d ?? {}) as JsonObject;
    for (const [key, name] of Object.entries(HANDSHAKE_PLACEHOLDERS)) {
      if (placeholderName(handshake[key]) !== name) throw new Error(`replay: ${path}.events[${index}].d.d.${key} must be one of the placeholders {"$":"${name}"}`);
    }
  });
}

function checkValue(project: string, path: string, key: string, value: Json): void {
  if (typeof value === 'string') {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(value)) throw new Error(`replay: ${path} holds ${name}`);
    }
    const isDocumentName = value.startsWith('projects/') && value.includes('/databases/');
    if (isDocumentName && !value.startsWith(`projects/${project}/`)) {
      throw new Error(`replay: ${path} names ${value}, outside project ${project}`);
    }
  }
  const allowed = PLACEHOLDER_KEYS[key];
  if (allowed && !allowed.includes(placeholderName(value) as PlaceholderName)) {
    throw new Error(`replay: ${path} must be one of the placeholders ${allowed.map((name) => `{"$":"${name}"}`).join(', ')}`);
  }
}

/** Calls `visit` for every keyed value under `value`, depth first. Placeholders are leaves. */
function walk(value: Json, path: string, visit: (path: string, key: string, value: Json) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visit(`${path}[${index}]`, '', item);
      walk(item, `${path}[${index}]`, visit);
    });
    return;
  }
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject || placeholderName(value) !== null) return;
  for (const [key, item] of Object.entries(value)) {
    visit(`${path}.${key}`, key, item);
    walk(item, `${path}.${key}`, visit);
  }
}
