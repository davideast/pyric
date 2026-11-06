// One RTDB WebSocket connection (wire protocol v5), answered from recorded
// exchanges. It fails closed like the Firestore replay: a message no
// recording holds gets the status `pyric_replay_no_recording` and is listed
// in `unmatched`.
//
// On open the connection sends the handshake recorded for its instance. Each
// data message `{ r, a, b }` is matched to a recorded exchange by `a` and `b`
// (with `matches`, so `{ "$": "any" }` matches any value, and
// `{ "$": "pushId" }` a push key the client picked, kept for later answers)
// and the uid the connection authenticated as; the exchange's events go out
// first, then its reply under the request's `r`. A listen's `later` batches go
// out on this connection when the exchange each names is answered, until the
// client unlistens or the connection closes. An onDisconnect write (`o`, `om`)
// counts as answered when the connection closes, as production runs it then.
//
// Some messages need no recording: stats (`s`) and unlisten (`n`) are
// answered `ok`, `auth` is answered from the claims of the ID token this
// server minted (a token it did not mint drops the connection's identity, as
// production does), `gauth` with `owner` (the Admin SDK's, under
// `FIREBASE_DATABASE_EMULATOR_HOST`) runs the connection as `owner`, `unauth` clears the uid, and the keepalive frame `0` is
// ignored. A message split into several frames (a frame count first) is
// refused and the connection closed: no recording holds one yet. Every frame
// a client sends but the keepalive is listed in `received`, answered or not.
import { placeholderName, type Json, type JsonObject, type RtdbBatch, type RtdbExchange } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { fill, matches, type ReplayTokens } from './values.ts';

/** Where a connection's frames go: a WebSocket on the replay server. */
export interface RtdbSocket {
  send(text: string): void;
  close(): void;
}

/** One connection's instance and every frame the server sent on it, in order. */
export interface RtdbLog {
  instance: string;
  sent: JsonObject[];
}

/** A frame a client sent on an RTDB connection, as the uid the connection had then. */
export interface RtdbReceived {
  rpc: 'rtdb';
  as: string | null;
  /** The frame as JSON, or its text when it is not a JSON object. */
  message: { instance: string; frame: Json };
}

/** What every RTDB connection on one replay server shares. */
export class RtdbShared {
  /** Every frame clients sent but the keepalive, in arrival order. */
  readonly received: RtdbReceived[] = [];
  /** The push keys clients picked, by the name of the `pushId` placeholder that matched each. */
  readonly pushKeys = new Map<string, string>();
  /** Every connection in the order it opened. */
  readonly connections: RtdbLog[] = [];
}

/** The status a reply carries when no recording answers the request. */
export const NO_RECORDING = 'pyric_replay_no_recording';

/** Data actions answered `ok` with no recording: connection stats and unlisten. */
const ALWAYS_OK = new Set(['s', 'n']);
const AUTH_ACTIONS = new Set(['auth', 'gauth']);
/**
 * The credential the Admin SDK sends in `gauth` under
 * `FIREBASE_DATABASE_EMULATOR_HOST`. A connection that sends it runs as
 * `owner`, so only exchanges with `"as": "owner"` (or no `as`) answer it.
 */
const ADMIN_CREDENTIAL = 'owner';
/** onDisconnect writes, which production runs when the connection closes. */
const ON_DISCONNECT_WRITES = new Set(['o', 'om']);
const KEEPALIVE = '0';
const FRAME_COUNT = /^\d{1,6}$/;
/** A push key: 20 characters of the SDK's push alphabet. */
const PUSH_KEY = /^[-0-9A-Za-z_]{20}$/;
/** An object key filled with a push key in an answer. */
const PUSH_KEY_PREFIX = '$pushId:';

/** What fills an answer's connection-level placeholders. */
interface ConnectionValues {
  host: string;
  session: string;
  pushKeys: Map<string, string>;
}

export class RtdbConnection {
  private as: string | null = null;
  private readonly values: ConnectionValues;
  private readonly log: RtdbLog;
  /** Stops each active listen's `later` batches, by the path it listens on. */
  private readonly listens = new Map<string, () => void>();
  /** The onDisconnect writes this connection registered, run when it closes. */
  private onDisconnect: Array<{ path: string; id: string }> = [];

  /** `host` is the `host:port` the client connected to, which the handshake names so the client reconnects there. */
  constructor(private readonly socket: RtdbSocket, private readonly state: ReplayState, private readonly shared: RtdbShared, readonly instance: string, host: string) {
    this.values = { host, session: state.tokens.opaque('rtdb-session'), pushKeys: shared.pushKeys };
    this.log = { instance, sent: [] };
    shared.connections.push(this.log);
  }

  /** Sends the instance's recorded handshake, or refuses an instance no recording holds and closes. */
  open(): void {
    const exchange = this.state.take<RtdbExchange>('rtdb', this.as, (candidate) => candidate.instance === this.instance && candidate.request === undefined);
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request: { instance: this.instance } });
      this.socket.close();
      return;
    }
    this.guarded(() => this.sendEvents(exchange));
  }

  onFrame(text: string): void {
    if (text === KEEPALIVE) return;
    const frame = parseFrame(text);
    this.shared.received.push({ rpc: 'rtdb', as: this.as, message: { instance: this.instance, frame: frame ?? text } });
    if (FRAME_COUNT.test(text)) return this.refuse({ instance: this.instance, frames: Number(text) });
    const data = frame?.t === 'd' ? (frame.d as JsonObject) : null;
    if (!data) return this.refuse({ instance: this.instance, frame: frame ?? text });
    this.guarded(() => this.answer(data));
  }

  /** The connection closed: runs its onDisconnect writes and stops its listens. */
  close(): void {
    for (const stop of this.listens.values()) stop();
    this.listens.clear();
    const writes = this.onDisconnect;
    this.onDisconnect = [];
    for (const { id } of writes) this.state.writes.emit('answered', id, undefined);
  }

  private answer(data: JsonObject): void {
    const action = String(data.a);
    const body = data.b ?? null;
    const r = typeof data.r === 'number' ? data.r : null;
    if (action === 'n') this.unlisten(pathOf(body));
    if (ALWAYS_OK.has(action)) return this.reply(r, { s: 'ok', d: '' });
    if (AUTH_ACTIONS.has(action)) return this.authenticate(r, action, body);
    if (action === 'unauth') {
      this.as = null;
      return this.reply(r, { s: 'ok', d: '' });
    }
    const exchange = this.take(action, body);
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request: { instance: this.instance, a: action, b: body } });
      return this.reply(r, { s: NO_RECORDING, d: `${NO_RECORDING}: no recorded exchange for ${action} ${JSON.stringify(body)}` });
    }
    this.sendEvents(exchange);
    if (exchange.reply) this.reply(r, this.fill(exchange.reply as JsonObject));
    this.settle(exchange, action, pathOf(body));
  }

  /** The recorded exchange for a request, keeping any push key the client picked in it. */
  private take(action: string, body: Json): RtdbExchange | null {
    const fits = (candidate: RtdbExchange) => candidate.instance === this.instance && candidate.request?.a === action && matchesRequest(candidate.request.b, body, this.state.tokens, new Map());
    const exchange = this.state.take<RtdbExchange>('rtdb', this.as, fits);
    if (!exchange?.request) return null;
    const picked = new Map<string, string>();
    matchesRequest(exchange.request.b, body, this.state.tokens, picked);
    for (const [name, key] of picked) this.shared.pushKeys.set(name, key);
    return exchange;
  }

  /**
   * What answering an exchange sets going: a listen starts its `later`
   * batches, an onDisconnect write waits for the connection to close, and any
   * other exchange releases the batches that wait on it.
   */
  private settle(exchange: RtdbExchange, action: string, path: string): void {
    if (exchange.later?.length) this.listen(path, exchange.later);
    if (ON_DISCONNECT_WRITES.has(action)) {
      this.onDisconnect.push({ path, id: exchange.id });
      return;
    }
    if (action === 'oc') this.onDisconnect = this.onDisconnect.filter((write) => !isAtOrBelow(write.path, path));
    this.state.writes.emit('answered', exchange.id, undefined);
  }

  private listen(path: string, later: RtdbBatch[]): void {
    this.unlisten(path);
    const onAnswered = (id: string) => this.guarded(() => {
      for (const batch of later.filter((candidate) => candidate.after === id)) {
        for (const event of batch.events) this.send(this.fill(event));
      }
    });
    this.state.writes.on('answered', onAnswered);
    this.listens.set(path, () => this.state.writes.off('answered', onAnswered));
  }

  private unlisten(path: string): void {
    this.listens.get(path)?.();
    this.listens.delete(path);
  }

  /**
   * Answers `auth` as the uid of an ID token this server minted, with that
   * token's claims, and the Admin SDK's `gauth` with `owner` as `owner`. The
   * `gauth` reply is hand-written: capture A never records that frame. Any
   * other credential drops the connection's identity, as production does when
   * a token fails to verify.
   */
  private authenticate(r: number | null, action: string, body: Json): void {
    const cred = (body as JsonObject | null)?.cred;
    const token = typeof cred === 'string' ? cred : undefined;
    const isAdmin = action === 'gauth' && token === ADMIN_CREDENTIAL;
    if (isAdmin) {
      this.as = ADMIN_CREDENTIAL;
      return this.reply(r, { s: 'ok', d: { auth: null, expires: null } });
    }
    const uid = this.state.tokens.uidOf(token);
    if (uid === null || token === undefined) {
      this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request: { instance: this.instance, a: 'auth', b: { cred: token === undefined ? null : 'a token this server did not mint' } } });
      this.as = null;
      return this.reply(r, { s: NO_RECORDING, d: `${NO_RECORDING}: the auth credential is not a token this server minted` });
    }
    this.as = uid;
    const claims = claimsOf(token);
    const provider = String((claims.firebase as JsonObject | undefined)?.sign_in_provider ?? 'custom');
    const auth = { provider, provider_id: provider, user_id: uid, token: claims, uid };
    this.reply(r, { s: 'ok', d: { auth, expires: claims.exp ?? null } });
  }

  private sendEvents(exchange: RtdbExchange): void {
    for (const event of exchange.events ?? []) this.send(this.fill(event));
  }

  private reply(r: number | null, b: JsonObject): void {
    if (r === null) return;
    this.send({ t: 'd', d: { r, b } });
  }

  private send(frame: JsonObject): void {
    this.log.sent.push(frame);
    this.socket.send(JSON.stringify(frame));
  }

  private refuse(request: JsonObject): void {
    this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request });
    this.socket.close();
  }

  /** Runs `answer`, refusing the connection with the reason when a recording cannot be filled. */
  private guarded(answer: () => void): void {
    try {
      answer();
    } catch (error) {
      this.refuse({ instance: this.instance, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A copy of a recorded value with the connection's placeholders and every shared one filled. */
  private fill(value: JsonObject): JsonObject {
    return fill(fillConnection(value, this.values), this.state.context()) as JsonObject;
  }
}

/**
 * Whether a request value matches a recorded one, as `matches` does, where a
 * `pushId` placeholder matches `<parent>/<key>` for any push key and puts the
 * key in `picked` under the placeholder's name.
 */
function matchesRequest(recorded: Json, actual: Json | undefined, tokens: ReplayTokens, picked: Map<string, string>): boolean {
  const name = placeholderName(recorded);
  if (name === 'pushId') return matchesPushId(recorded as JsonObject, actual, picked);
  if (Array.isArray(recorded)) {
    return Array.isArray(actual) && actual.length === recorded.length && recorded.every((item, index) => matchesRequest(item, actual[index], tokens, picked));
  }
  const isPlainObject = typeof recorded === 'object' && recorded !== null && name === null;
  if (!isPlainObject) return matches(recorded, actual, tokens);
  const isActualObject = typeof actual === 'object' && actual !== null && !Array.isArray(actual);
  if (!isActualObject) return false;
  const recordedKeys = Object.keys(recorded).sort();
  const actualKeys = Object.keys(actual).sort();
  const sameKeys = recordedKeys.length === actualKeys.length && recordedKeys.every((key, index) => key === actualKeys[index]);
  return sameKeys && recordedKeys.every((key) => matchesRequest(recorded[key] ?? null, actual[key], tokens, picked));
}

function matchesPushId(placeholder: JsonObject, actual: Json | undefined, picked: Map<string, string>): boolean {
  if (typeof actual !== 'string') return false;
  const prefix = typeof placeholder.parent === 'string' ? `${placeholder.parent}/` : '';
  const key = actual.startsWith(prefix) ? actual.slice(prefix.length) : '';
  if (!PUSH_KEY.test(key)) return false;
  picked.set(String(placeholder.name), key);
  return true;
}

/** Fills the handshake's placeholders, `pushId` placeholders, and `$pushId:<name>` object keys. */
function fillConnection(value: Json, values: ConnectionValues): Json {
  const name = placeholderName(value);
  if (name === 'serverTime') return Date.now();
  if (name === 'host' || name === 'session') return values[name];
  if (name === 'pushId') return pushPath(value as JsonObject, values.pushKeys);
  if (name !== null) return value;
  if (Array.isArray(value)) return value.map((item) => fillConnection(item, values));
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [fillKey(key, values.pushKeys), fillConnection(item, values)]));
}

function pushPath(placeholder: JsonObject, pushKeys: Map<string, string>): string {
  const key = pushKey(String(placeholder.name), pushKeys);
  return typeof placeholder.parent === 'string' ? `${placeholder.parent}/${key}` : key;
}

function fillKey(key: string, pushKeys: Map<string, string>): string {
  return key.startsWith(PUSH_KEY_PREFIX) ? pushKey(key.slice(PUSH_KEY_PREFIX.length), pushKeys) : key;
}

function pushKey(name: string, pushKeys: Map<string, string>): string {
  const key = pushKeys.get(name);
  if (key === undefined) throw new Error(`replay: an answer names the push key ${name}, which no client has pushed`);
  return key;
}

/** The `p` of a data message's body. */
function pathOf(body: Json): string {
  const path = (body as JsonObject | null)?.p;
  return typeof path === 'string' ? path : '';
}

function isAtOrBelow(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`);
}

/** A frame as JSON, or null for text that is not a JSON object. */
function parseFrame(text: string): JsonObject | null {
  try {
    const frame = JSON.parse(text) as Json;
    const isObject = typeof frame === 'object' && frame !== null && !Array.isArray(frame);
    return isObject ? frame : null;
  } catch {
    return null;
  }
}

/** The claims of a minted ID token: its middle segment. */
function claimsOf(token: string): JsonObject {
  const [, payload = ''] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JsonObject;
}
