// Firebase Installations and FCM registrations, the two REST APIs
// `firebase/messaging` calls in getToken and deleteToken, answered from
// recorded `messaging` exchanges. A request matches on its API, method, path,
// the header values the exchange names and its JSON body. The answer is the
// recorded status, headers and body with its placeholders filled.
//
// The replay keeps what production would: every FID an Installations create
// registered, every FIS auth token it issued, and every registration token a
// registrations create issued. A `fisAuthToken` header matches only a token
// this server issued, and a `{fcmToken}` or `{fid}` path segment only a value
// it issued, so a call made with values from anywhere else fails closed.
//
// Fails closed: a request no exchange answers, or a body that is not JSON,
// gets a 400 whose message starts `pyric_replay_no_recording:` and is listed
// in `unmatched`. Not a 5xx: `@firebase/installations` retries those
// (`retryIfServerError`), so a missing recording would slow the test instead
// of failing it.
import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { placeholderName, type Json, type JsonObject, type MessagingApi, type MessagingExchange } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { NO_RECORDING } from './storage.ts';
import { fill, matches } from './values.ts';

export const INSTALLATIONS_HOST = 'firebaseinstallations.googleapis.com';
export const REGISTRATIONS_HOST = 'fcmregistrations.googleapis.com';

/** Each Messaging host and the API it serves. */
export const MESSAGING_HOSTS: Record<string, MessagingApi> = { [INSTALLATIONS_HOST]: 'installations', [REGISTRATIONS_HOST]: 'registrations' };

/** The scheme the registrations API reads in `x-goog-firebase-installations-auth`. */
const FIS_SCHEME = 'FIS ';

/** Path segments that stand for a value this server issued. */
const ISSUED_SEGMENTS: Record<string, 'fid' | 'fcmToken'> = { '{fid}': 'fid', '{fcmToken}': 'fcmToken' };

/** One Messaging call as the replay matches it. */
export interface MessagingRequest {
  api: MessagingApi;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON body, absent for none. */
  body?: JsonObject;
  /** Why the replay could not read the request, which it then refuses. */
  unreadable?: string;
}

/** One Messaging call the server received: its API, method and path, never its headers or body. */
export interface MessagingReceived {
  rpc: 'messaging';
  as: null;
  message: JsonObject;
}

export interface MessagingAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Reads one Messaging call from its API, method, path, headers and raw body. */
export function readMessagingRequest(api: MessagingApi, method: string, path: string, headers: IncomingHttpHeaders, body: string): MessagingRequest {
  const request: MessagingRequest = { api, method, path, headers };
  if (body.length === 0) return request;
  try {
    const parsed = JSON.parse(body) as Json;
    const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    if (!isObject) return { ...request, unreadable: 'its body is not a JSON object' };
    return { ...request, body: parsed };
  } catch {
    return { ...request, unreadable: 'its body is not JSON' };
  }
}

/** Messaging state one replay server keeps: the calls it received and the FIDs and tokens it issued. */
export class MessagingReplay {
  readonly received: MessagingReceived[] = [];
  private readonly issued = { fid: new Set<string>(), fisAuthToken: new Set<string>(), fcmToken: new Set<string>() };
  private readonly used = new Set<string>();

  constructor(private readonly state: ReplayState) {}

  answer(request: MessagingRequest): MessagingAnswer {
    this.received.push({ rpc: 'messaging', as: null, message: describe(request) });
    if (request.unreadable) return this.refuse(request, request.unreadable);
    const exchange = this.take(request);
    if (!exchange) return this.refuse(request);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(exchange.response.headers ?? {})) headers[name] = String(value);
    const body = this.fillIssued(exchange.response.body, request, exchange, {});
    return { status: exchange.response.status, headers, body: JSON.stringify(fill(body, this.state.context())) };
  }

  /** The first fitting exchange not yet used, or the last fitting one when all are. */
  private take(request: MessagingRequest): MessagingExchange | null {
    const candidates = this.state.recordings
      .flatMap((recording) => recording.exchanges)
      .filter((exchange): exchange is MessagingExchange => exchange.kind === 'messaging' && this.fits(exchange, request));
    const chosen = candidates.find((exchange) => !this.used.has(exchange.id)) ?? candidates.at(-1) ?? null;
    if (chosen) this.used.add(chosen.id);
    return chosen;
  }

  private fits(exchange: MessagingExchange, request: MessagingRequest): boolean {
    const recorded = exchange.request;
    const sameCall = exchange.api === request.api && recorded.method === request.method && this.pathFits(recorded.path, request.path);
    const sameHeaders = Object.entries(recorded.headers ?? {}).every(([name, value]) => this.headerFits(value, headerOf(request.headers, name)));
    const sameBody = recorded.body === undefined ? request.body === undefined : matches(recorded.body, request.body);
    return sameCall && sameHeaders && sameBody;
  }

  /** The paths match segment for segment, where `{fid}` and `{fcmToken}` match a value this server issued. */
  private pathFits(recorded: string, actual: string): boolean {
    const want = recorded.split('/');
    const got = actual.split('/');
    return want.length === got.length && want.every((segment, index) => {
      const issued = ISSUED_SEGMENTS[segment];
      return issued ? this.issued[issued].has(got[index]!) : segment === got[index];
    });
  }

  /** A header matches its recorded value, where `fisAuthToken` matches `FIS <token>` for a token this server issued. */
  private headerFits(recorded: Json, actual: string | undefined): boolean {
    if (placeholderName(recorded) !== 'fisAuthToken') return matches(recorded, actual);
    const isFis = actual !== undefined && actual.startsWith(FIS_SCHEME);
    return isFis && this.issued.fisAuthToken.has(actual.slice(FIS_SCHEME.length));
  }

  /**
   * A copy of `body` with its `fid`, `fisAuthToken` and `fcmToken`
   * placeholders filled. Each is one value per answer: `fid` the FID the
   * request sent (or its path names), `fcmToken` the token the path names or a
   * fresh one, `fisAuthToken` a fresh one. Every value filled is recorded as
   * issued.
   */
  private fillIssued(body: Json, request: MessagingRequest, exchange: MessagingExchange, values: Partial<Record<'fid' | 'fisAuthToken' | 'fcmToken', string>>): Json {
    if (Array.isArray(body)) return body.map((item) => this.fillIssued(item, request, exchange, values));
    const isObject = typeof body === 'object' && body !== null;
    if (!isObject) return body;
    const name = placeholderName(body);
    if (name === 'fid' || name === 'fisAuthToken' || name === 'fcmToken') {
      values[name] ??= this.issue(name, this.namedBy(name, request, exchange));
      return `${typeof body.prefix === 'string' ? body.prefix : ''}${values[name]}`;
    }
    if (name !== null) return body;
    return Object.fromEntries(Object.entries(body).map(([key, item]) => [key, this.fillIssued(item, request, exchange, values)]));
  }

  /** The value a request already names for a placeholder: the FID its body sent, or the segment its path holds where the recorded path has `{fid}` or `{fcmToken}`. */
  private namedBy(name: 'fid' | 'fisAuthToken' | 'fcmToken', request: MessagingRequest, exchange: MessagingExchange): string | undefined {
    if (name === 'fid' && typeof request.body?.fid === 'string') return request.body.fid;
    const index = exchange.request.path.split('/').indexOf(`{${name}}`);
    return index === -1 ? undefined : request.path.split('/')[index];
  }

  private issue(name: 'fid' | 'fisAuthToken' | 'fcmToken', named: string | undefined): string {
    const value = named ?? `replay-${name}-${randomBytes(12).toString('base64url')}`;
    this.issued[name].add(value);
    return value;
  }

  private refuse(request: MessagingRequest, reason?: string): MessagingAnswer {
    const call = `${request.method} ${request.path}`;
    const api = request.api === 'installations' ? 'Installations' : 'FCM registrations';
    const message = reason ? `${NO_RECORDING}: the replay cannot answer ${api} ${call}: ${reason}` : `${NO_RECORDING}: no recorded ${api} call answers ${call}`;
    this.state.unmatched.push({ rpc: 'http', as: null, request: { service: 'messaging', ...describe(request) } });
    const body = { error: { code: 400, message, status: 'INVALID_ARGUMENT' } };
    return { status: 400, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) };
  }
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** A request as `received` and `unmatched` list it: the call, never its headers or body. */
function describe(request: MessagingRequest): JsonObject {
  return { api: request.api, method: request.method, path: request.path };
}
