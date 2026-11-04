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
export type ObservedCallService = 'firestore' | 'auth';

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
  /** The document or collection path the call named, when it named one. */
  path?: string;
  /** When the app made the call, in ms since epoch. */
  at: number;
  /** How long production took to answer, in ms. */
  durationMs?: number;
  outcome: ProductionOutcome;
  /** Absent when the call ran signed out. */
  account?: ObservedAccount;
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
