/**
 * A call an app made to production, as a client observed it.
 *
 * Pyric did not serve the call. The app's own Firebase SDK sent it to the
 * real project, and a recorder beside the app reported what production
 * answered. A host accepts the record from a client connection and writes it
 * to the event stream as an `operation` event whose Rules disposition is
 * `external-execution` and whose `production` field holds the answer. A
 * call a server process made through the Admin SDK is marked `sdk: 'admin'`
 * and becomes an event that bypassed Security Rules under the Admin lens,
 * with production's answer beside it.
 */

/** The services a client may report observed calls for. */
export type ObservedCallService = 'firestore' | 'auth' | 'rtdb' | 'ai' | 'storage' | 'messaging';

/** What production answered: success, or the error code it returned. */
export type ProductionOutcome =
  | { status: 'ok' }
  | { status: 'error'; code: string };

/**
 * What production answered, as a client reports it: a {@link ProductionOutcome}
 * whose error may also carry production's own message, as the SDK's error
 * held it (`Missing or insufficient permissions.`). The message is at most
 * 500 characters, and one shaped like a token is dropped. Only the host's
 * terminal prints it: the event's `production.outcome` holds the status and
 * code alone.
 *
 * `failure` is the reader's, never a client's: `missing-index` when the code
 * is `failed-precondition` and the message says the query requires an index.
 * The reader decides it before it drops a token-shaped message, since the
 * console link in production's index message often reads as one. The event
 * carries it as `detail.failure`, as a sandbox RTDB query's missing index does.
 */
export type ObservedOutcome =
  | { status: 'ok' }
  | { status: 'error'; code: string; message?: string; failure?: 'missing-index' };

/**
 * The signed-in account a call ran as: the account id, the names of its
 * token claims, and their values. Never the token. The values stay in the
 * host's memory so the local rules can read `request.auth.token`; no event
 * holds them.
 */
export interface ObservedAccount {
  uid: string;
  claimNames?: string[];
  /** The token's claims by name, as JSON values. Absent when the client did not send them. */
  claims?: Record<string, unknown>;
}

/**
 * The token counts production reported for an AI call, as the SDK parsed them
 * from `usageMetadata` (or, for `countTokens`, its `totalTokens`). Numbers only.
 */
export interface ObservedAiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /** `countTokens` only. */
  totalTokens?: number;
}

/**
 * What an `ai` call records beside production's answer: the model and the
 * token counts. Never a prompt, a part, response text, a function call or a
 * header.
 */
export interface ObservedAi {
  /** The model resource the SDK normalized, such as `models/gemini-flash-lite-latest`. */
  model: string;
  /** The `modelVersion` production reported, when the SDK kept it. */
  reportedModel?: string;
  usage?: ObservedAiUsage;
  /** On a stream: ms from the call until the method resolved with its first chunk. */
  firstChunkMs?: number;
  /**
   * On a call production answered with no usable content: the first
   * candidate's `finishReason` when it is not `STOP` or `MAX_TOKENS`
   * (`SAFETY`, `RECITATION`, `BLOCKLIST`). Production answers a filter block
   * with HTTP 200, so the call's outcome is still `ok`.
   */
  finishReason?: string;
  /** On a prompt production refused before generation: `promptFeedback.blockReason`. */
  blockReason?: string;
}

/** The Google APIs a Messaging call sends its requests to. */
export type ObservedRequestApi = 'installations' | 'registrations';

/**
 * One request a Messaging call made, as Resource Timing saw it: the API, what
 * the request did, and the HTTP status production answered. Installations
 * requests `create` an installation or `generateAuthToken`; FCM registration
 * requests `create`, `update` or `delete` a registration. Never the URL, the
 * project, the installation id or a token.
 */
export interface ObservedRequest {
  api: ObservedRequestApi;
  action: 'create' | 'generateAuthToken' | 'update' | 'delete';
  /** The response's HTTP status, from 100 to 599. Absent when the browser reported none. */
  status?: number;
}

/**
 * What production billed or moved for a call, as the recorder measured it
 * from the SDK's answer: document reads, writes and deletes, payload and
 * transfer bytes, and how many parts it could not measure. Counts only, each
 * a non-negative safe integer; never a document, a value or a payload.
 */
export interface ObservedUsage {
  documentReads?: number;
  documentWrites?: number;
  documentDeletes?: number;
  /** The JSON size of a delivered RTDB value, or of a Firestore payload. */
  payloadBytes?: number;
  uploadedBytes?: number;
  downloadedBytes?: number;
  /** Parts of the call production bills that the SDK's answer does not reveal. */
  unmeasured?: number;
}

/** The operators a Firestore `where` filter takes. */
export type ObservedQueryOperator =
  | '<'
  | '<='
  | '=='
  | '!='
  | '>='
  | '>'
  | 'array-contains'
  | 'in'
  | 'not-in'
  | 'array-contains-any';

/** One `where` filter: the field path and the operator. Never the value. */
export interface ObservedQueryFilter {
  field: string;
  op: ObservedQueryOperator;
}

/** One `orderBy`: the field path and the direction. */
export interface ObservedQueryOrder {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * The shape of a Firestore query a call ran: its scope, the fields it
 * filtered and ordered on, and whether it set a limit. Never a filter value,
 * a cursor or the limit's number. `fingerprint` is a hash of the filter and
 * cursor values the page computed, so two runs of one query with different
 * values read as different targets without either value leaving the page.
 */
export interface ObservedQuery {
  scope: 'collection' | 'collection-group';
  filters?: ObservedQueryFilter[];
  orderBy?: ObservedQueryOrder[];
  limit?: true;
  /** Exactly 16 lowercase hex characters. */
  fingerprint?: string;
}

/**
 * A listener's lifecycle, as the page saw it: the app subscribed (`attach`)
 * or unsubscribed (`detach`). Deliveries are calls of their own; this record
 * carries none, and production answered nothing for it.
 */
export interface ObservedListener {
  phase: 'attach' | 'detach';
  /**
   * The id the page or process minted for this subscription, shared by its
   * attach and detach: at most 64 letters, digits, `_` and `-`. The host
   * scopes it to the connection, so two callers may mint the same id.
   */
  id: string;
  /**
   * What the listener watches: a Firestore document or collection path, a
   * collection group's id, or an RTDB path. Bounded as the call's `path`
   * is, so any target a call's path may name is taken.
   */
  target: string;
  /**
   * A hash of the key the page's listener journal gives this listener,
   * equal for two listeners on one document or query: exactly 16 lowercase
   * hex characters. Never the key itself, which holds the query's values.
   */
  key?: string;
}

/** One observed call, as a client sends it to a host. */
export interface ObservedCall {
  service: ObservedCallService;
  /**
   * The SDK function the app called, such as `getDoc` or
   * `signInWithEmailAndPassword`. An Admin call names its class and method,
   * such as `DocumentReference.get` or `Auth.verifyIdToken`.
   */
  method: string;
  /**
   * `'admin'` when a server process made the call through the Admin SDK,
   * which bypasses Security Rules; absent for the client SDK. Taken only on
   * `firestore`, `rtdb`, `storage` and `auth` calls; the event carries it as
   * `detail.sdk`.
   */
  sdk?: 'admin';
  /**
   * The document or collection path the call named, when it named one. On an
   * `rtdb` call, the reference's path, such as `/items/a`. On a `storage`
   * call, the reference's `fullPath`, absent for the bucket's root. Never on
   * an `ai` call, whose event path is its model, or a `messaging` call.
   */
  path?: string;
  /**
   * `rtdb` only: the name of the database instance the call went to, as the
   * SDK's namespace names it (`my-project-default-rtdb`, `my-project-named`).
   * Required on every RTDB call, the default instance included, and refused
   * on any other; the event leaves it out for the project's default instance.
   */
  instance?: string;
  /**
   * `storage` only: the bucket the reference named, as a bare bucket name
   * (`my-project.firebasestorage.app`), never a `gs://` URL. Required on every
   * Storage call and refused on any other; the event carries it as
   * `detail.bucket`, the key the sandbox's own Storage events use.
   */
  bucket?: string;
  /** When the app made the call, in ms since epoch. */
  at: number;
  /** How long production took to answer, in ms. */
  durationMs?: number;
  outcome: ObservedOutcome;
  /** Absent when the call ran signed out. */
  account?: ObservedAccount;
  /**
   * The project the app's Firebase config named for this call
   * (`app.options.projectId`): where the call actually went. Absent when the
   * recorder could not read it.
   */
  projectId?: string;
  /**
   * On a listener delivery: the documents production billed it for, those
   * added, changed or removed, and at least one on the listener's first
   * snapshot. Zero for a snapshot only its metadata changed, which production
   * does not bill. Absent when the recorder could not count them, and then a
   * delivery counts once.
   */
  billedDocuments?: number;
  /** What production billed or moved for the call, when the recorder measured it. */
  usage?: ObservedUsage;
  /** Required on every `ai` call, and refused on any other. */
  ai?: ObservedAi;
  /**
   * `messaging` only: the Installations and FCM registration requests a
   * `getToken` or `deleteToken` made, at most four, in the order they started.
   * Refused on any other call; the event carries them as `detail.requests`.
   */
  requests?: ObservedRequest[];

  /**
   * `firestore` (`setDoc`, `updateDoc`, `addDoc`), `rtdb` (`set`,
   * `setWithPriority`, `update`, `push`), or `storage` (`uploadBytes`,
   * `uploadString`, `uploadBytesResumable`, `updateMetadata`): the written
   * JSON value or object metadata so local rules can inspect `request.resource`
   * / `newData`. Memory only; no event holds them.
   */
  writeData?: ObservedWriteValue;
  /**
   * `firestore` or `storage` (`getMetadata`): the fields or metadata of the
   * stored document/object an allowed read returned, so local rules can inspect
   * `resource.data` or `resource`. Memory only; no event holds them.
   */
  document?: Record<string, unknown>;
  /**
   * `firestore` only: the shape of the query a list or listener ran. Refused
   * on any other call; the event carries it as `request.query`.
   */
  query?: ObservedQuery;
  /**
   * `firestore` and `rtdb` only: a listener's attach or detach. Refused on
   * any other call and on an error outcome. Such a record becomes a
   * `listener` event, not an `operation` event.
   */
  listener?: ObservedListener;
  /**
   * `firestore` and `rtdb` client deliveries only: the subscription id minted
   * on the listener's attach, so the host can correlate each delivered snapshot
   * with its attached listener. Refused on any other service, on an Admin call,
   * on an error outcome, or alongside `listener`.
   */
  listenerId?: string;
}

/**
 * Validated path-level summary of one observed live listener delivery, stored
 * on `event.detail.delivery` without field values.
 *
 * - `snapshot`: `paths` lists the current top-level child paths (full-node
 *   `onValue` deliveries).
 * - `delta`: `paths` lists added or modified paths and `removedPaths` lists
 *   deleted paths (`onSnapshot` `docChanges` and RTDB `onChild*` callbacks).
 */
export interface ObservedDeliverySummary {
  readonly mode: 'snapshot' | 'delta';
  /** Uncapped item or document count of the delivery. */
  readonly size: number;
  /** Canonical paths added, present, or modified (capped at 64 entries). */
  readonly paths: readonly string[];
  /** Canonical paths removed in `delta` mode (capped at 64 entries). */
  readonly removedPaths?: readonly string[];
}

export type ObservedWriteValue =
  | string
  | number
  | boolean
  | null
  | unknown[]
  | Record<string, unknown>;

/**
 * The production side of an observed `operation` event. Its presence means
 * production served the call and pyric only watched it.
 */
export interface ObservedProduction {
  outcome: ProductionOutcome;
  /** The account's claim names; the account id is the event's `auth.uid`. */
  claimNames?: string[];
  /** The call's {@link ObservedCall.usage}, when the recorder measured it. */
  usage?: ObservedUsage;
  /** A listener delivery's {@link ObservedCall.billedDocuments}, when the recorder counted them. */
  billedDocuments?: number;
  /**
   * What the local rules files say about the same request, when the host
   * evaluated it. Production decided the call: this never changes the
   * event's `result` or Rules disposition.
   */
  local?: LocalVerdict;
}

/**
 * Data a local evaluation needed and an observed call did not carry: a
 * stored document (`resource`, `get()`, `exists()`, or an RTDB `data` or
 * `root`), the written value, a token claim's value, or a list's query.
 */
export type LocalVerdictGap = 'stored-document' | 'write-data' | 'claim-values' | 'query';

/** The local rule that decided: its source line, its condition, and the match path it sits under. */
export interface LocalRule {
  line?: number;
  expression?: string;
  path?: string;
}

/**
 * The bounded Realtime Database local evaluation record on a live verdict:
 * the rule node path and expression, `$variable` bindings along the path,
 * the engine's reason or implicit-deny code, and (on a decided verdict) the
 * root-first rule trace. Absent for other services and when the record was
 * too large to keep.
 */
export interface LocalRtdbEvaluation {
  matchedPath?: string;
  matchedRule?: string;
  pathVariableBindings?: Record<string, string>;
  reason?: string;
  errorCode?: string;
  rtdbTrace?: import('@pyric/rules/internal/rtdb').RtdbRuleEvaluation[];
}

/**
 * The bounded Cloud Storage local evaluation record on a live verdict:
 * the matched `match` block path and `allow` line, and per-rule evaluation
 * reasons.
 */
export interface LocalStorageEvaluation {
  matchedPath?: string;
  matchedLine?: number;
  reasons?: string[];
}

/**
 * The local rules' answer to an observed call. `drift` marks an answer
 * that disagrees with production's allow or deny. `trace` is the same
 * bounded evaluation record a sandbox Firestore request carries as
 * `rulesEvidence`; `rtdb` carries the bounded Realtime Database rule context
 * and trace; `storage` carries the bounded Cloud Storage match context and
 * evaluation reasons. An `unevaluated` verdict preserves `rule` / `rtdb` /
 * `storage` rule-node context when determinable, without a decided trace.
 */
export type LocalVerdict =
  | {
      result: 'allow' | 'deny';
      rule?: LocalRule;
      drift?: true;
      trace?: import('./rules-evidence.js').RulesEvidence;
      rtdb?: LocalRtdbEvaluation;
      storage?: LocalStorageEvaluation;
    }
  | {
      result: 'unevaluated';
      needs: LocalVerdictGap[];
      /** Canonical resource or document paths whose absence from observed session state paused local evaluation. */
      missingPaths?: string[];
      rule?: LocalRule;
      rtdb?: LocalRtdbEvaluation;
      storage?: LocalStorageEvaluation;
    };
