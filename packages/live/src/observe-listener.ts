/**
 * Subscription lifecycle tracking for `@pyric/live` listener exports
 * (`onSnapshot`, `onValue`, `onChild*`).
 *
 * Mints per-realm unique subscription ids (`l-<realm>-<n>`), records `attached`
 * once per subscription, and ensures `detached` fires once regardless of
 * whether teardown comes from the returned unsubscribe, RTDB `off()`,
 * `{ onlyOnce: true }` delivery, or a listener error.
 */
import { randomKey, realmHash } from './keyed-hash.js';
import type {
  Callback,
  ListenerIdentity,
  LiveCallOutcome,
  LiveListenerLifecycle,
  ObservedSite,
} from './observe.js';

/** This realm's prefix for the listener ids it mints: random, so a reloaded page never reuses a past page's id. */
const LISTENER_REALM = Array.from(randomKey().slice(0, 4), (byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');
let listenerSerial = 0;

/** A fresh listener id, `l-<realm>-<n>`: unique in this realm and unlike any other realm's. */
export function mintListenerId(): string {
  listenerSerial += 1;
  return `l-${LISTENER_REALM}-${listenerSerial}`;
}

/** What the module's hook says the listener watches, or undefined when it has no hook, names nothing or throws. */
function identityOf(site: ObservedSite, args: readonly unknown[]): ListenerIdentity | undefined {
  try {
    return site.listenerOf?.(site.name, args);
  } catch {
    return undefined;
  }
}

export interface ListenerLifecycleHooks {
  report(site: ObservedSite, outcome: LiveCallOutcome, payload?: unknown): unknown;
  closeActivity(site: ObservedSite): void;
  endListener(site: ObservedSite): void;
}

/** One subscription's lifecycle: the fields its site carries, and the step that records it attached. */
export interface ListenerSubscriptionLifecycle {
  readonly fields: Required<
    Pick<ObservedSite, 'listener' | 'endListener' | 'ensureAttached' | 'path'>
  > &
    Pick<ObservedSite, 'detachesOnDelivery'>;
  bind(attachedSite: ObservedSite, appArgs: readonly unknown[]): void;
  attached(): void;
}

/**
 * Build the lifecycle for one subscription the module's hook names: a fresh id,
 * the realm's keyed hash of its key, and its target as the path of every record
 * it makes when the call's context named none.
 */
export function createListenerLifecycle(
  site: ObservedSite,
  args: readonly unknown[],
  hooks: ListenerLifecycleHooks,
): ListenerSubscriptionLifecycle | undefined {
  const identity = identityOf(site, args);
  if (identity === undefined) return undefined;
  const listener: LiveListenerLifecycle = { id: mintListenerId(), key: realmHash(identity.key) };
  let attachedOnce = false;
  let ended = false;
  let forget: (() => void) | undefined;
  let boundSite: ObservedSite | undefined;
  let boundArgs: readonly unknown[] = args;
  const detachesOnDelivery = site.listenerOnlyOnce?.(args) === true;
  const ensureAttached = (): void => {
    if (attachedOnce || boundSite === undefined) return;
    attachedOnce = true;
    const attachedSite = boundSite;
    hooks.report(attachedSite, 'attached');
    // A listener the module ends without its unsubscribe (RTDB `off()`) closes its journal activity too.
    const endedElsewhere = (): void => {
      fields.endListener();
      hooks.closeActivity(attachedSite);
    };
    try {
      forget = site.listenerAttached?.(site.name, boundArgs, endedElsewhere);
    } catch {
      // A module that cannot note the subscription still has its unsubscribe and errors.
    }
  };
  const endListener = (): void => {
    if (ended) return;
    ended = true;
    forget?.();
    hooks.report({ ...site, ...fields }, 'detached');
  };
  let fields: ListenerSubscriptionLifecycle['fields'] = {
    listener,
    path: site.path ?? identity.target,
    ensureAttached,
    endListener,
  };
  if (detachesOnDelivery) {
    fields = { ...fields, detachesOnDelivery: true };
  }
  return {
    fields,
    bind(attachedSite, appArgs) {
      boundSite = attachedSite;
      boundArgs = appArgs;
    },
    attached: ensureAttached,
  };
}

/** Subscribes as the app called it and records `attached`, or `threw` when the SDK threw. */
export function subscribeWithLifecycle(
  site: ObservedSite,
  lifecycle: ListenerSubscriptionLifecycle,
  call: { real: Callback; self: unknown; args: unknown[]; appArgs: readonly unknown[] },
  report: ListenerLifecycleHooks['report'],
): unknown {
  lifecycle.bind(site, call.appArgs);
  let unsubscribe: unknown;
  try {
    unsubscribe = Reflect.apply(call.real, call.self, call.args);
  } catch (error) {
    if (site.throwsLocally !== true) report(site, 'threw', error);
    throw error;
  }
  lifecycle.attached();
  return unsubscribe;
}

/** The SDK's unsubscribe, recording the listener's `detached` first. Any other result is passed back unchanged. */
export function wrapEndingUnsubscribe(
  site: ObservedSite,
  unsubscribe: unknown,
  endListener: ListenerLifecycleHooks['endListener'],
): unknown {
  if (typeof unsubscribe !== 'function') return unsubscribe;
  return function unsubscribed(this: unknown, ...values: unknown[]): unknown {
    endListener(site);
    return Reflect.apply(unsubscribe as Callback, this, values);
  };
}
