// One RTDB WebSocket connection (wire protocol v5), answered from recorded
// exchanges. It fails closed like the Firestore replay: a message no
// recording holds gets the status `pyric_replay_no_recording` and is listed
// in `unmatched`.
//
// On open the connection sends the handshake recorded for its instance. Each
// data message `{ r, a, b }` is matched to a recorded exchange by `a` and `b`
// (with `matches`, so `{ "$": "any" }` matches any value)
// and the uid the connection authenticated as; the exchange's events go out
// first, then its reply under the request's `r`. Some messages need no
// recording: stats (`s`) and unlisten (`n`) are answered `ok`, `auth` is
// answered from the claims of the ID token this server minted, `unauth`
// clears the uid, and the keepalive frame `0` is ignored. A message split
// into several frames (a frame count first) is refused and the connection
// closed: no recording holds one yet.
import { placeholderName, type Json, type JsonObject, type PlaceholderName, type RtdbExchange } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { fill, matches } from './values.ts';

/** Where a connection's frames go: a `ws` socket on the replay server. */
export interface RtdbSocket {
  send(text: string): void;
  close(): void;
}

/** The status a reply carries when no recording answers the request. */
export const NO_RECORDING = 'pyric_replay_no_recording';

/** Data actions answered `ok` with no recording: connection stats and unlisten. */
const ALWAYS_OK = new Set(['s', 'n']);
const AUTH_ACTIONS = new Set(['auth', 'gauth']);
const KEEPALIVE = '0';
const FRAME_COUNT = /^\d{1,6}$/;

/** What fills a handshake's placeholders for one connection. */
interface HandshakeValues {
  host: string;
  session: string;
}

export class RtdbConnection {
  private as: string | null = null;
  private readonly handshake: HandshakeValues;

  /** `host` is the `host:port` the client connected to, which the handshake names so the client reconnects there. */
  constructor(private readonly socket: RtdbSocket, private readonly state: ReplayState, readonly instance: string, host: string) {
    this.handshake = { host, session: state.tokens.opaque('rtdb-session') };
  }

  /** Sends the instance's recorded handshake, or refuses an instance no recording holds and closes. */
  open(): void {
    const exchange = this.state.take<RtdbExchange>('rtdb', this.as, (candidate) => candidate.instance === this.instance && candidate.request === undefined);
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request: { instance: this.instance } });
      this.socket.close();
      return;
    }
    this.sendEvents(exchange);
  }

  onFrame(text: string): void {
    if (text === KEEPALIVE) return;
    if (FRAME_COUNT.test(text)) return this.refuse({ instance: this.instance, frames: Number(text) });
    const frame = parseFrame(text);
    const data = frame?.t === 'd' ? (frame.d as JsonObject) : null;
    if (!data) return this.refuse({ instance: this.instance, frame: frame ?? text });
    this.answer(data);
  }

  private answer(data: JsonObject): void {
    const action = String(data.a);
    const body = data.b ?? null;
    const r = typeof data.r === 'number' ? data.r : null;
    if (ALWAYS_OK.has(action)) return this.reply(r, { s: 'ok', d: '' });
    if (AUTH_ACTIONS.has(action)) return this.authenticate(r, body);
    if (action === 'unauth') {
      this.as = null;
      return this.reply(r, { s: 'ok', d: '' });
    }
    const request = { a: action, b: body };
    const exchange = this.state.take<RtdbExchange>('rtdb', this.as, (candidate) => candidate.instance === this.instance && candidate.request?.a === action && matches(candidate.request.b, body, this.state.tokens));
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request: { instance: this.instance, ...request } });
      return this.reply(r, { s: NO_RECORDING, d: `${NO_RECORDING}: no recorded exchange for ${action} ${JSON.stringify(body)}` });
    }
    this.sendEvents(exchange);
    if (exchange.reply) this.reply(r, this.fill(exchange.reply as JsonObject));
  }

  /** Answers `auth` as the uid of an ID token this server minted, with that token's claims. */
  private authenticate(r: number | null, body: Json): void {
    const cred = (body as JsonObject | null)?.cred;
    const token = typeof cred === 'string' ? cred : undefined;
    const uid = this.state.tokens.uidOf(token);
    if (uid === null || token === undefined) {
      this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request: { instance: this.instance, a: 'auth', b: { cred: token === undefined ? null : 'a token this server did not mint' } } });
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

  private send(frame: Json): void {
    this.socket.send(JSON.stringify(frame));
  }

  private refuse(request: JsonObject): void {
    this.state.unmatched.push({ rpc: 'rtdb', as: this.as, request });
    this.socket.close();
  }

  /** A copy of a recorded value with the handshake's placeholders and every shared one filled. */
  private fill(value: JsonObject): JsonObject {
    return fill(fillHandshake(value, this.handshake), this.state.context()) as JsonObject;
  }
}

const HANDSHAKE_NAMES: PlaceholderName[] = ['host', 'session', 'serverTime'];

function fillHandshake(value: Json, values: HandshakeValues): Json {
  const name = placeholderName(value);
  if (name !== null && HANDSHAKE_NAMES.includes(name)) return name === 'serverTime' ? Date.now() : values[name as keyof HandshakeValues];
  if (name !== null) return value;
  if (Array.isArray(value)) return value.map((item) => fillHandshake(item, values));
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillHandshake(item, values)]));
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
