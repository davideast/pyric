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
export type ObservedCallService = 'firestore' | 'auth' | 'rtdb';

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

/** One observed call, as a client sends it to a host. */
export interface ObservedCall {
  service: ObservedCallService;
  /** The SDK function the app called, such as `getDoc` or `signInWithEmailAndPassword`. */
  method: string;
  /**
   * The document or collection path the call named, when it named one. On an
   * `rtdb` call, the reference's path, such as `/items/a`.
   */
  path?: string;
  /**
   * `rtdb` only: the name of the database instance the call went to, as the
   * SDK's namespace names it (`my-project-default-rtdb`, `my-project-named`).
   * Required on every RTDB call, the default instance included, and refused
   * on any other; the event leaves it out for the project's default instance.
   */
  instance?: string;
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
}

/**
 * The production side of an observed `operation` event. Its presence means
 * production served the call and pyric only watched it.
 */
export interface ObservedProduction {
  outcome: ProductionOutcome;
  /** The account's claim names; the account id is the event's `auth.uid`. */
  claimNames?: string[];
}
