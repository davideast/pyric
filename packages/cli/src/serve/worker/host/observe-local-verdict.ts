/**
 * The local rules' verdict on a call production served.
 *
 * A live host loads the app's rules files into the sandbox like any other.
 * When a client reports a Firestore, RTDB or Storage call production
 * answered, the host runs the same request through the sandbox's own engine
 * for that service (`observe-local-firestore.ts`, `observe-local-rtdb.ts`,
 * `observe-local-storage.ts`), with `request.auth` built from the uid the
 * call carries, and records what the local rules say beside production's
 * answer. Production decided, so this only reports: the event's result and
 * Rules disposition stay production's.
 *
 * A call may carry its token's claim values (`request.auth.token`), the value
 * a write sent (a Firestore write's fields, an RTDB write's value, a Storage
 * upload's metadata) and what a read returned (a Firestore document, a
 * Storage object's metadata); the host feeds them to the engine from memory
 * and keeps them off the event, except as the scalar check values a Firestore
 * verdict's trace holds, as a sandbox request's `rulesEvidence` does. It never
 * carries a `get()` or `exists()` document, the stored RTDB tree or a query. A
 * verdict that rests on data the call did not carry is `unevaluated`, naming
 * what it needed, rather than a guess the local rules would not make with the
 * data in hand. A service whose rules file the app did not load gets no
 * verdict: the sandbox's stand-in rules are not the app's.
 */
import { observedMethod, rtdbRulesMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import type { LocalVerdict } from './observe-local-evaluation.js';
import { firestoreVerdict } from './observe-local-firestore.js';
import { rtdbVerdict } from './observe-local-rtdb.js';
import { storageVerdict } from './observe-local-storage.js';

/**
 * What the app's loaded rules say about an observed call, or `undefined`
 * for a call no loaded rules govern: an Admin SDK call, an Auth, AI or
 * Messaging call, a Firestore listener or transaction, an RTDB transaction or
 * `onDisconnect`, or a service whose rules file the app did not load.
 * Never throws: a local evaluation that fails leaves the event as production
 * answered it.
 */
export function localVerdict(ctx: HostCtx, call: ObservedCall): LocalVerdict | undefined {
  if (call.sdk === 'admin') return undefined;
  try {
    if (call.service === 'firestore') {
      const method = observedMethod('firestore', call.method);
      return method === null ? undefined : firestoreVerdict(ctx, call, method);
    }
    if (call.service === 'rtdb') {
      const method = rtdbRulesMethod(call.method);
      return method === null ? undefined : rtdbVerdict(ctx, call, method);
    }
    if (call.service === 'storage') {
      const method = observedMethod('storage', call.method);
      return method === null ? undefined : storageVerdict(ctx, call, method);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
