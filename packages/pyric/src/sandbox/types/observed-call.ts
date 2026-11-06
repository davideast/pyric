/**
 * A call an app made to production, as a client observed it.
 *
 * Pyric did not serve the call. The app's own Firebase SDK sent it to the
 * real project, and a recorder beside the app reported what production
 * answered. A host accepts the record from a client connection and writes it
 * to the event stream as an `operation` event whose Rules disposition is
 * `external-execution` and whose `production` field holds the answer.
 */

/** The services a client may report observed calls for. */
export type ObservedCallService = 'firestore' | 'auth' | 'rtdb' | 'ai' | 'storage' | 'messaging';

/** What production answered: success, or the error code it returned. */
export type ProductionOutcome =
  | { status: 'ok' }
  | { status: 'error'; code: string };

/**
 * The signed-in account a call ran as: the account id and the names of its
 * token claims. Never the token, and never a claim's value.
 */
export interface ObservedAccount {
  uid: string;
  claimNames?: string[];
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

/** One observed call, as a client sends it to a host. */
export interface ObservedCall {
  service: ObservedCallService;
  /** The SDK function the app called, such as `getDoc` or `signInWithEmailAndPassword`. */
  method: string;
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
  outcome: ProductionOutcome;
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
}

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
 * Data a local evaluation needed and an observed call does not carry: a
 * stored document (`resource`, `get()`, `exists()`, or an RTDB `data` or
 * `root`), the written value, or a token claim's value.
 */
export type LocalVerdictGap = 'stored-document' | 'write-data' | 'claim-values';

/** The local rule that decided: its source line, its condition, and the match path it sits under. */
export interface LocalRule {
  line?: number;
  expression?: string;
  path?: string;
}

/**
 * The local rules' answer to an observed call. `drift` marks an answer
 * that disagrees with production's allow or deny.
 */
export type LocalVerdict =
  | { result: 'allow' | 'deny'; rule?: LocalRule; drift?: true }
  | { result: 'unevaluated'; needs: LocalVerdictGap[] };
