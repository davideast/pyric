// Turns what a recorder saw on the wire into recorded exchanges, reduced to
// shapes and test-project values: tokens, read times, resume tokens and commit
// times become placeholders, a password becomes `any`, and an ID token keeps
// only the uid, email and provider the replay server mints a new one from.
import { FORMAT, type AuthExchange, type Json, type JsonObject, type ListenBatch, type ListenExchange, type Recording, type WriteExchange } from './format.ts';
import { targetShape } from './firestore.ts';

const placeholder = (name: string): JsonObject => ({ $: name });

/** The claims of a JWT, read without checking its signature. Null for anything else. */
export function jwtClaims(token: string | undefined): JsonObject | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JsonObject;
  } catch {
    return null;
  }
}

/** The uid a bearer header names, or null for none. */
export function uidOfBearer(authorization: string | undefined): string | null {
  const claims = jwtClaims(/^Bearer (.+)$/.exec(authorization ?? '')?.[1]);
  const uid = claims?.user_id ?? claims?.sub;
  return typeof uid === 'string' ? uid : null;
}

function idTokenPlaceholder(token: string): JsonObject {
  const claims = jwtClaims(token) ?? {};
  const firebase = (claims.firebase ?? {}) as JsonObject;
  return {
    $: 'idToken',
    uid: String(claims.user_id ?? claims.sub ?? ''),
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    provider: String(firebase.sign_in_provider ?? 'password'),
  };
}

const REQUEST_ANY = new Set(['password', 'idToken', 'refreshToken', 'refresh_token', 'captchaResponse', 'recaptchaToken', 'oobCode']);
const RESPONSE_DROPPED = new Set(['passwordHash', 'salt']);

function sanitizeAuthBody(value: Json, side: 'request' | 'response'): Json {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuthBody(item, side));
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  const entries: Array<[string, Json]> = [];
  for (const [key, item] of Object.entries(value)) {
    const isTokenString = typeof item === 'string';
    // A request's ID token names its account, so two accounts' calls replay apart.
    if (side === 'request' && key === 'idToken' && isTokenString) entries.push([key, { $: 'idToken', uid: idTokenPlaceholder(item).uid as string }]);
    else if (side === 'request' && REQUEST_ANY.has(key)) entries.push([key, placeholder('any')]);
    else if (side === 'response' && RESPONSE_DROPPED.has(key)) continue;
    else if (side === 'response' && isTokenString && ['idToken', 'id_token', 'access_token'].includes(key)) entries.push([key, idTokenPlaceholder(item)]);
    else if (side === 'response' && ['refreshToken', 'refresh_token'].includes(key)) entries.push([key, placeholder('refreshToken')]);
    else entries.push([key, sanitizeAuthBody(item, side)]);
  }
  return Object.fromEntries(entries);
}

/**
 * The write a Listen message may have been released by: the one sent and not
 * yet answered, else the last one answered. The Listen and Write streams reach
 * the recorder on separate connections, so a listener change can arrive before
 * the answer to the write that caused it.
 */
interface WriteRef {
  inFlight: string | null;
  answered: string | null;
}

/** One Listen target the recorder is following. */
interface FollowedTarget {
  exchange: ListenExchange;
  removed: boolean;
  /** Whether the last batch ended at a global target change, so the next message opens a batch. */
  batchClosed: boolean;
}

/** What one recorded stream needs from the transcript it belongs to. */
export class Transcript {
  private readonly exchanges: Array<ListenExchange | WriteExchange | AuthExchange> = [];
  private count = 0;
  /** The last write production answered, which releases the Listen batches that follow it. */
  private lastWrite: string | null = null;
  /** The last write sent and not yet answered. Its id is taken when it is sent. */
  private sentWrite: string | null = null;
  /** The commit time of each answered write, by id. A failed write has none. */
  private readonly commitTimes = new Map<string, string | undefined>();
  /** The write each Listen batch and message was received after, resolved when the recording is made. */
  private readonly refs = new WeakMap<object, WriteRef>();

  constructor(private readonly project: string, private readonly source: string) {}

  nextId(kind: string): string {
    this.count += 1;
    return `${kind}-${this.count}`;
  }

  auth(request: AuthExchange['request'], response: AuthExchange['response']): void {
    this.exchanges.push({
      kind: 'auth',
      id: this.nextId('auth'),
      request: { ...request, ...(request.body ? { body: sanitizeAuthBody(request.body, 'request') as JsonObject } : {}) },
      response: { status: response.status, body: sanitizeAuthBody(response.body, 'response') as JsonObject },
    });
  }

  listenStream(as: string | null): RecordedListen {
    return new RecordedListen(this, as);
  }

  writeStream(as: string | null): RecordedWrite {
    return new RecordedWrite(this, as);
  }

  add(exchange: ListenExchange | WriteExchange): void {
    this.exchanges.push(exchange);
  }

  /** Takes the id of a write the client is sending, before production answers it. */
  sendingWrite(): string {
    this.sentWrite = this.nextId('write');
    return this.sentWrite;
  }

  answeredWrite(id: string, commitTime: string | undefined): void {
    this.lastWrite = id;
    this.commitTimes.set(id, commitTime);
    if (this.sentWrite === id) this.sentWrite = null;
  }

  /** Notes the write `item` (a batch or a message) came after, as things stand now. */
  noteWrite(item: object): void {
    this.refs.set(item, { inFlight: this.sentWrite, answered: this.lastWrite });
  }

  recording(): Recording {
    const exchanges = this.exchanges.map((exchange) => exchange.kind === 'listen' ? withoutEmptyBatches(this.resolved(exchange)) : exchange);
    return { format: FORMAT, project: this.project, source: this.source, exchanges };
  }

  /** The write `item` came after: the one in flight if production answered it, else the last one answered. */
  private writeOf(item: object): string | undefined {
    const ref = this.refs.get(item);
    if (!ref) return undefined;
    const { inFlight, answered } = ref;
    const inFlightWasAnswered = inFlight !== null && this.commitTimes.has(inFlight);
    if (inFlightWasAnswered) return inFlight;
    return answered ?? undefined;
  }

  /** The exchange with each batch tied to the write that released it and each message sanitized. */
  private resolved(exchange: ListenExchange): ListenExchange {
    const batches = exchange.batches.map((batch, index) => {
      const after = index === 0 ? undefined : this.writeOf(batch);
      const messages = batch.messages.map((message) => {
        const write = this.writeOf(message);
        return sanitizeListen(message, write === undefined ? undefined : this.commitTimes.get(write));
      });
      return { ...(after ? { after } : {}), messages };
    });
    return { ...exchange, batches };
  }
}

/** A Listen message with its ids, times and tokens as placeholders. */
function sanitizeListen(message: JsonObject, commitTime: string | undefined): JsonObject {
  const replace = (value: Json, key: string): Json => {
    if (key === 'targetIds' || key === 'removedTargetIds') return [placeholder('targetId')];
    if (key === 'readTime') return placeholder('readTime');
    if (key === 'resumeToken') return placeholder('resumeToken');
    const isCommitTime = (key === 'updateTime' || key === 'createTime') && commitTime !== undefined && value === commitTime;
    if (isCommitTime) return placeholder('commitTime');
    if (Array.isArray(value)) return value.map((item) => replace(item, ''));
    const isObject = typeof value === 'object' && value !== null;
    if (!isObject) return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replace(item, name)]));
  };
  return replace(message, '') as JsonObject;
}

function withoutEmptyBatches(exchange: ListenExchange): ListenExchange {
  const onlyResumeTokens = (messages: JsonObject[]) => messages.every((message) => {
    const change = message.targetChange as JsonObject | undefined;
    return change !== undefined && (change.targetChangeType ?? 'NO_CHANGE') === 'NO_CHANGE' && !change.cause;
  });
  const batches = exchange.batches.filter((batch, index) => index === 0 || !onlyResumeTokens(batch.messages));
  return { ...exchange, batches };
}

/** A Listen stream: client targets in, server changes out, grouped per target into batches. */
export class RecordedListen {
  private readonly targets = new Map<number, FollowedTarget>();

  constructor(private readonly transcript: Transcript, private readonly as: string | null) {}

  fromClient(message: JsonObject): void {
    const addTarget = message.addTarget as JsonObject | undefined;
    if (addTarget) {
      const exchange: ListenExchange = { kind: 'listen', id: this.transcript.nextId('listen'), as: this.as, target: targetShape(addTarget), batches: [{ messages: [] }] };
      this.transcript.add(exchange);
      this.targets.set(addTarget.targetId as number, { exchange, removed: false, batchClosed: false });
    }
    const removed = this.targets.get(message.removeTarget as number);
    if (removed) removed.removed = true;
  }

  fromServer(message: JsonObject): void {
    const change = message.targetChange as JsonObject | undefined;
    const targetIds = targetIdsOf(message);
    const isGlobal = change !== undefined && targetIds.length === 0;
    if (isGlobal) {
      for (const target of this.targets.values()) target.batchClosed = true;
      return;
    }
    for (const targetId of targetIds) {
      const target = this.targets.get(targetId);
      const isRemoveAck = change?.targetChangeType === 'REMOVE' && !change.cause && target?.removed;
      if (!target || isRemoveAck) continue;
      if (target.batchClosed) this.openBatch(target);
      const batches = target.exchange.batches;
      this.transcript.noteWrite(message);
      batches[batches.length - 1]!.messages.push(message);
    }
  }

  private openBatch(target: FollowedTarget): void {
    target.batchClosed = false;
    const batch: ListenBatch = { messages: [] };
    this.transcript.noteWrite(batch);
    target.exchange.batches.push(batch);
  }
}

function targetIdsOf(message: JsonObject): number[] {
  const body = Object.values(message)[0] as JsonObject | undefined;
  const ids = [...((body?.targetIds as number[] | undefined) ?? []), ...((body?.removedTargetIds as number[] | undefined) ?? [])];
  return [...new Set(ids)];
}

/** A Write stream: each message with writes, and production's answer or stream error. */
export class RecordedWrite {
  private pending: { id: string; writes: Json[] } | null = null;

  constructor(private readonly transcript: Transcript, private readonly as: string | null) {}

  fromClient(message: JsonObject): void {
    const writes = message.writes as Json[] | undefined;
    if (writes && writes.length > 0) this.pending = { id: this.transcript.sendingWrite(), writes };
  }

  fromServer(message: JsonObject): void {
    if (!this.pending) return;
    const { id, writes } = this.pending;
    const error = message.error as WriteExchange['error'] | undefined;
    const isAnswer = error !== undefined || message.writeResults !== undefined || message.commitTime !== undefined;
    if (!isAnswer) return;
    this.pending = null;
    if (error) {
      this.transcript.add({ kind: 'write', id, as: this.as, writes, error: { code: error.code, status: error.status, message: error.message } });
      this.transcript.answeredWrite(id, undefined);
      return;
    }
    const commitTime = typeof message.commitTime === 'string' ? message.commitTime : undefined;
    const results = ((message.writeResults as JsonObject[] | undefined) ?? []).map((result) => (
      result.updateTime === commitTime ? { ...result, updateTime: placeholder('commitTime') } : result
    ));
    const response: JsonObject = { writeResults: results, ...(commitTime ? { commitTime: placeholder('commitTime') } : {}) };
    this.transcript.add({ kind: 'write', id, as: this.as, writes, response });
    this.transcript.answeredWrite(id, commitTime);
  }
}
