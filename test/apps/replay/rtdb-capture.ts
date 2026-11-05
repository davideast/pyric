// Capture A (`packages/conformance/src/capture/rtdb-live/recordings/capture-a-wire.json`)
// as `rtdb` exchanges, converted when a replay server loads it, so no copied
// fixture can drift from what production sent.
//
// The capture holds every frame two clients sent and received on each
// instance, by connection. Each request is paired with the reply that carries
// its connection and `r`. A server-pushed frame on a connection goes out
// before the next reply that connection was waiting for; one that arrived
// while the connection waited for nothing was caused by another connection's
// write, so it becomes a `later` batch of the connection's latest listen,
// released by the latest write on another connection before it (an
// onDisconnect write counts from the moment its connection closed). Stats,
// unlisten and `auth` are answered by the server itself (`rtdb.ts`), so they
// become no exchange.
//
// The capture's placeholders become test-project values: `<project>` the
// project, `<default-instance>` `<project>-default-rtdb`, `<named-instance>`
// `<project>-named`, `<run>` `replay`, and `<uid-N>` `user-N`. Handshake
// values become the `host`, `session` and `serverTime` placeholders, and each
// push key a client picked becomes a `pushId` placeholder named `push-N` in
// the order the keys first appear.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertShapesOnly, FORMAT, type Json, type JsonObject, type Recording, type RtdbExchange } from './format.ts';

export const CAPTURE_A = fileURLToPath(new URL('../../../packages/conformance/src/capture/rtdb-live/recordings/capture-a-wire.json', import.meta.url));
/** What the capture's `<run>` becomes: every path it wrote sits under `/pyric-live-capture/<run>`. */
export const CAPTURE_RUN = 'replay';

export interface CaptureConnection {
  id: number;
  client: string;
  openedAtMs: number;
  closedAtMs: number;
}

export interface CaptureFrame {
  t: number;
  dir: 'sent' | 'received';
  client: string;
  connection: number;
  op: string;
  data: string;
}

export interface CaptureInstance {
  instance: string;
  connections: CaptureConnection[];
  frames: CaptureFrame[];
}

export interface Capture {
  sdkVersion: string;
  instances: Record<string, CaptureInstance>;
}

export function readCapture(path: string = CAPTURE_A): Capture {
  return JSON.parse(readFileSync(path, 'utf8')) as Capture;
}

/** Capture A as a replay recording for `project`, checked like any recording. */
export function loadCaptureA(project: string, path: string = CAPTURE_A): Recording {
  const recording = captureRecording(readCapture(path), project);
  assertShapesOnly(recording);
  return recording;
}

/** The instance a capture's instance label stands for in `project`. */
export function captureInstance(project: string, label: string): string {
  return label === 'default' ? `${project}-default-rtdb` : `${project}-${label}`;
}

/** A frame's text with the capture's placeholders as test-project values. */
export function captureText(text: string, project: string): string {
  return text
    .replace(/<([a-z]+)-instance>/g, (_, label: string) => captureInstance(project, label))
    .replaceAll('<project>', project)
    .replaceAll('<run>', CAPTURE_RUN)
    .replace(/<uid-(\d+)>/g, (_, n: string) => `user-${n}`);
}

/** A push key as the SDK picks one today: a leading `-` and 19 more characters of its alphabet. */
const PUSH_KEY = /^-[-0-9A-Za-z_]{19}$/;

/** The push keys the capture's clients picked, in the order they first appear. */
export function capturePushKeys(capture: Capture): string[] {
  const keys: string[] = [];
  for (const frame of Object.values(capture.instances).flatMap((instance) => instance.frames)) {
    if (frame.dir !== 'sent') continue;
    const data = (JSON.parse(frame.data) as JsonObject).d as JsonObject | undefined;
    const path = (data?.b as JsonObject | undefined)?.p;
    const last = typeof path === 'string' ? path.split('/').at(-1) ?? '' : '';
    if (data?.a === 'p' && PUSH_KEY.test(last) && !keys.includes(last)) keys.push(last);
  }
  return keys;
}

export function captureRecording(capture: Capture, project: string): Recording {
  const keys = new Map(capturePushKeys(capture).map((key, index) => [key, `push-${index + 1}`]));
  const exchanges = Object.entries(capture.instances).flatMap(([label, instance]) => new InstanceConversion(label, captureInstance(project, label), instance, keys).run(project));
  const leftover = /<[a-z]+(-[a-z0-9]+)*>/.exec(JSON.stringify(exchanges));
  if (leftover) throw new Error(`capture: ${leftover[0]} is a capture placeholder the conversion does not replace`);
  return {
    format: FORMAT,
    project,
    source: `capture A (packages/conformance/src/capture/rtdb-live/recordings/capture-a-wire.json, firebase ${capture.sdkVersion}), converted when loaded`,
    exchanges,
  };
}

/** Requests the replay server answers itself: stats, unlisten and auth. */
const SERVER_ANSWERED = new Set(['s', 'n', 'auth', 'gauth', 'unauth']);
const WRITES = new Set(['p', 'm']);
const ON_DISCONNECT_WRITES = new Set(['o', 'om']);

/** A request waiting for its reply; `exchange` is null for one the server answers itself. */
interface Pending {
  action: string;
  exchange: RtdbExchange | null;
}

class InstanceConversion {
  private readonly exchanges: RtdbExchange[] = [];
  private readonly connectionOf = new Map<RtdbExchange, number>();
  private readonly pending = new Map<number, Map<number, Pending>>();
  private readonly uids = new Map<number, string>();
  private readonly listens = new Map<number, RtdbExchange>();
  private readonly writes: Array<{ connection: number; id: string; at: number }> = [];

  constructor(private readonly label: string, private readonly instance: string, private readonly capture: CaptureInstance, private readonly keys: Map<string, string>) {}

  run(project: string): RtdbExchange[] {
    for (const frame of this.capture.frames) {
      const parsed = templatePushKeys(JSON.parse(captureText(frame.data, project)) as Json, this.keys) as JsonObject;
      if (frame.dir === 'sent') this.sent(frame, parsed);
      else this.received(frame, parsed);
    }
    for (const exchange of this.exchanges) {
      if (exchange.request) exchange.as = this.uids.get(this.connectionOf.get(exchange)!) ?? null;
    }
    return this.exchanges;
  }

  private sent(frame: CaptureFrame, parsed: JsonObject): void {
    const data = parsed.d as JsonObject;
    const action = String(data.a);
    const r = Number(data.r);
    if (SERVER_ANSWERED.has(action)) return void this.waiting(frame.connection).set(r, { action, exchange: null });
    const exchange: RtdbExchange = { kind: 'rtdb', id: `${this.label}-${frame.connection}-r${r}`, instance: this.instance, request: { a: action, b: data.b ?? null } };
    this.add(exchange, frame.connection);
    this.waiting(frame.connection).set(r, { action, exchange });
    if (action === 'q') this.listens.set(frame.connection, exchange);
    if (WRITES.has(action)) this.writes.push({ connection: frame.connection, id: exchange.id, at: frame.t });
    if (ON_DISCONNECT_WRITES.has(action)) this.writes.push({ connection: frame.connection, id: exchange.id, at: this.closedAt(frame.connection) });
  }

  private received(frame: CaptureFrame, parsed: JsonObject): void {
    if (parsed.t === 'c') return this.handshake(frame, parsed);
    const data = parsed.d as JsonObject;
    if (typeof data.r === 'number') return this.reply(frame.connection, data.r, data.b as JsonObject);
    this.event(frame, parsed);
  }

  private handshake(frame: CaptureFrame, parsed: JsonObject): void {
    const control = parsed.d as JsonObject;
    if (control.t !== 'h') throw new Error(`capture: control frame ${JSON.stringify(parsed)} at ${frame.t}ms is not a handshake`);
    const values = { ...(control.d as JsonObject), ts: { $: 'serverTime' }, h: { $: 'host' }, s: { $: 'session' } };
    this.add({ kind: 'rtdb', id: `${this.label}-${frame.connection}-connect`, instance: this.instance, events: [{ t: 'c', d: { t: 'h', d: values } }] }, frame.connection);
  }

  private reply(connection: number, r: number, b: JsonObject): void {
    const waiting = this.waiting(connection);
    const pending = waiting.get(r);
    if (!pending) throw new Error(`capture: connection ${connection} got a reply to r ${r}, which it never sent`);
    waiting.delete(r);
    if (pending.exchange) pending.exchange.reply = b as RtdbExchange['reply'];
    if (pending.action === 'auth') this.uids.set(connection, String(((b.d as JsonObject).auth as JsonObject).uid));
  }

  /** Ties a server-pushed frame to the request whose answer carries it, or to the write on another connection that caused it. */
  private event(frame: CaptureFrame, parsed: JsonObject): void {
    const next = [...this.waiting(frame.connection).values()].find((pending) => pending.exchange !== null)?.exchange;
    if (next) {
      (next.events ??= []).push(parsed);
      return;
    }
    const cause = this.writes.filter((write) => write.connection !== frame.connection && write.at < frame.t).at(-1);
    const listen = this.listens.get(frame.connection);
    if (!cause || !listen) throw new Error(`capture: the frame at ${frame.t}ms on connection ${frame.connection} follows no request or write`);
    const later = (listen.later ??= []);
    const last = later.at(-1);
    if (last?.after === cause.id) last.events.push(parsed);
    else later.push({ after: cause.id, events: [parsed] });
  }

  private add(exchange: RtdbExchange, connection: number): void {
    this.exchanges.push(exchange);
    this.connectionOf.set(exchange, connection);
  }

  private waiting(connection: number): Map<number, Pending> {
    let waiting = this.pending.get(connection);
    if (!waiting) this.pending.set(connection, (waiting = new Map()));
    return waiting;
  }

  private closedAt(connection: number): number {
    const found = this.capture.connections.find((candidate) => candidate.id === connection);
    if (!found) throw new Error(`capture: connection ${connection} is not listed`);
    return found.closedAtMs;
  }
}

/** A value with each known push key as a `pushId` placeholder: a path that ends in one, or an object key. */
function templatePushKeys(value: Json, keys: Map<string, string>): Json {
  if (typeof value === 'string') return pushPlaceholder(value, keys);
  if (Array.isArray(value)) return value.map((item) => templatePushKeys(item, keys));
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = keys.get(key);
    return [name ? `$pushId:${name}` : key, templatePushKeys(item, keys)];
  }));
}

function pushPlaceholder(text: string, keys: Map<string, string>): Json {
  const segments = text.split('/');
  const index = segments.findIndex((segment) => keys.has(segment));
  if (index === -1) return text;
  if (index !== segments.length - 1) throw new Error(`capture: ${text} has a push key before its last segment, which no placeholder holds`);
  const name = keys.get(segments[index]!)!;
  return index === 0 ? { $: 'pushId', name } : { $: 'pushId', name, parent: segments.slice(0, -1).join('/') };
}
