/**
 * Cross-tab realtime sync for the sandbox — opt-in, Firestore only.
 *
 * # Why this exists
 * Production Firestore uses WebSockets; every tab's `onSnapshot` listener
 * receives server-pushed updates from other clients automatically. The
 * sandbox is in-process: a write in Tab A updates Tab A's in-memory
 * LocalEnvironment, but Tab B's environment is independent — no connection
 * between them. This module bridges the gap by broadcasting committed writes
 * over a `BroadcastChannel` (same-origin, no server required) so a write in
 * Tab A fires `onSnapshot` listeners in Tab B, restoring the cross-client
 * realtime that production users expect.
 *
 * # Design
 * Three message kinds:
 *   - `write`  — a committed write event to propagate to other tabs.
 *   - `hello`  — sent on attach: "I just joined, please send me your state."
 *   - `state`  — reply to a specific `hello`: current snapshot of all docs.
 *
 * Every message carries `origin` (a per-tab random ID) so:
 *   (a) Echo suppression: a tab ignores messages it posted itself.
 *   (b) The `state` reply includes `to` so only the requesting tab applies it.
 *
 * # Echo / infinite-loop prevention
 * The critical invariant: applying a received write to the local env MUST NOT
 * re-broadcast that write. Without protection, the flow would be:
 *   Tab A writes → broadcasts → Tab B receives → applies via admin → emits
 *   `kind:'write'` onEvent → Tab B re-broadcasts → Tab A re-applies → loops.
 *
 * We break the loop with a boolean re-entrancy guard `applyingRemote`. It is
 * set to `true` around the synchronous apply call; the `onEvent` subscriber
 * checks it before broadcasting. Because `adminSetDocument` / `adminDeleteDocument`
 * are synchronous, the guard resets to `false` before any subsequent call.
 *
 * # Late-join handshake (hello/state)
 * When a tab joins after others have already written data, it sends a `hello`.
 * A responding tab replies with `state` (its snapshot). The joining tab applies
 * the snapshot ONLY when its own Firestore state is empty — it's a fresh tab
 * and the snapshot is the "initial seed". We don't clobber an active tab's
 * state with a peer's snapshot; that's a multi-writer concern outside our scope.
 * We also apply the state only once (first `state` message wins; duplicates are
 * ignored via the `stateApplied` flag).
 *
 * # Multi-writer divergence
 * Two tabs writing to the same document concurrently will produce divergent
 * local state (last-write-wins per tab, no conflict resolution). This is a
 * documented limitation — the intended model is a single active writer at a
 * time (the common UI development pattern: one user interacting with one tab).
 * Production Firestore also converges via server ordering that the sandbox
 * cannot replicate offline.
 *
 * # RTDB
 * Real-Time Database is explicitly NOT included here. Follow-on when RTDB
 * has its own in-process environment analogous to LocalEnvironment.
 */

import type { Sandbox, SandboxSnapshot, WriteSandboxEvent } from '../types.js';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Minimal interface that `BroadcastChannel` satisfies. Provided as an
 * injectable seam so tests can run without a real browser channel.
 *
 * The real `BroadcastChannel` global satisfies this interface out of the
 * box — pass it directly:
 *
 * ```ts
 * sandbox.enableTabSync({
 *   channel: new BroadcastChannel('pyric:tabsync'),
 * });
 * ```
 *
 * For SSR / Node environments, the default channel construction is guarded
 * (`typeof BroadcastChannel !== 'undefined'`) so the call site doesn't need
 * to branch — a missing global just means no sync, which is fine for server
 * renders that only care about initial data.
 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  close(): void;
}

/**
 * Options for `sandbox.enableTabSync(options?)`. All fields are optional;
 * the defaults provide a ready-to-use configuration for browser environments.
 */
export interface TabSyncOptions {
  /**
   * The broadcast channel to use. Defaults to
   * `new BroadcastChannel('pyric:tabsync')` when omitted and
   * `BroadcastChannel` is available in the global scope.
   *
   * Pass a custom implementation for tests or Node environments.
   */
  channel?: BroadcastChannelLike;

  /**
   * A string that uniquely identifies this tab's sandbox instance.
   * Used for echo suppression (messages with `origin === originId` are
   * silently dropped) and for directing `state` replies to the requesting tab.
   *
   * Defaults to `crypto.randomUUID()` when available, otherwise a
   * counter + process-uptime string (no `Date.now()` or `Math.random()`
   * — those change every call and can collide in fast tests).
   */
  originId?: string;
}

// ─── Message shapes ───────────────────────────────────────────────────────

/** A committed write event to propagate to peer tabs. */
interface WriteMessage {
  kind: 'write';
  origin: string;
  event: WriteSandboxEvent;
}

/** Sent on attach: "I just joined, please send me your current state." */
interface HelloMessage {
  kind: 'hello';
  origin: string;
}

/** Reply to a `hello` from the origin tab: a full doc snapshot for late-join sync. */
interface StateMessage {
  kind: 'state';
  origin: string;
  /** The originId of the tab that sent the `hello` — only that tab applies this. */
  to: string;
  /** The responding tab's Firestore documents at snapshot time. */
  snapshot: SandboxSnapshot;
}

type TabSyncMessage = WriteMessage | HelloMessage | StateMessage;

/** Type guard: checks that `v` is a plain object with a `kind` string field. */
function isTabSyncMessage(v: unknown): v is TabSyncMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).kind === 'string' &&
    typeof (v as Record<string, unknown>).origin === 'string'
  );
}

// ─── Origin ID generation ─────────────────────────────────────────────────

let _originCounter = 0;

/**
 * Generate a stable per-tab origin ID. Uses `crypto.randomUUID()` when
 * available (browsers, Node ≥ 19) and falls back to a counter + process
 * uptime string. The fallback avoids `Date.now()` and `Math.random()` —
 * both can produce the same value in rapid succession in test environments
 * (especially with fake timers). `process.hrtime.bigint()` or
 * `performance.now()` would be better but aren't universally available;
 * a simple monotonic counter is collision-free within one process.
 */
function generateOriginId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `tab-${crypto.randomUUID()}`;
  }
  // Fallback: process-unique counter. Not cryptographic, but sufficient
  // for same-process test environments where collision-resistance matters
  // most (two sandboxes in the same test must have different IDs).
  return `tab-${++_originCounter}-${typeof performance !== 'undefined' ? performance.now().toFixed(3) : String(Date.now())}`;
}

// ─── Core attach helper ───────────────────────────────────────────────────

/**
 * Attach cross-tab sync to a sandbox. Called by `SandboxImpl.enableTabSync`;
 * kept in a separate module so `sandbox-impl.ts` stays thin.
 *
 * Returns a `disable` function: calling it unsubscribes the onEvent listener,
 * removes the channel message listener, and closes the channel.
 *
 * @param sandbox  The sandbox to sync. Must expose `onEvent`, `admin`, and `snapshot`.
 * @param options  Optional channel and origin override.
 */
export function attachTabSync(sandbox: Sandbox, options: TabSyncOptions = {}): () => void {
  // ── Channel setup ────────────────────────────────────────────────────
  let channel: BroadcastChannelLike;
  let channelOwnedByUs = false; // track ownership so we close only our own channel

  if (options.channel) {
    channel = options.channel;
    // Caller owns this channel; we don't close it on disable.
    channelOwnedByUs = false;
  } else if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('pyric:tabsync');
    channelOwnedByUs = true;
  } else {
    // No BroadcastChannel available (e.g. SSR / old Node). Return a
    // no-op disable function so the call site doesn't need to guard.
    return () => { /* no-op: BroadcastChannel unavailable */ };
  }

  const originId = options.originId ?? generateOriginId();

  // ── Re-entrancy guard ────────────────────────────────────────────────
  //
  // WHY THIS EXISTS: applying a received write via `sandbox.admin.*`
  // causes `LocalEnvironment.adminSetDocument` → `notifyListenersForPaths`
  // → `SandboxImpl.emit` → our `onEvent` subscriber fires again. Without
  // a guard, that re-fire would postMessage the same event back to the
  // channel, which other tabs would receive and re-apply, and so on —
  // an infinite cross-tab loop. Setting `applyingRemote = true` before
  // the synchronous apply call and `false` after it breaks the cycle:
  // our onEvent subscriber checks the flag and skips broadcasting when
  // it knows the event came from a remote tab, not a local user write.
  //
  // The guard is a simple boolean because:
  //   1. `adminSetDocument` / `adminDeleteDocument` are synchronous.
  //   2. JavaScript is single-threaded — no concurrent mutation of the flag.
  //   3. A listener callback triggered by the admin apply is also synchronous
  //      (notification happens inside the admin call, not deferred).
  let applyingRemote = false;

  // ── State-applied flag for late-join ─────────────────────────────────
  //
  // We only apply a `state` message ONCE per enable() call. If multiple
  // tabs respond to our `hello`, we use the first reply and ignore the rest.
  // This prevents a second tab's snapshot from overwriting data that the
  // first snapshot plus our own interim writes produced.
  let stateApplied = false;

  // ── onEvent subscription: broadcast local writes ─────────────────────

  const unsubscribeOnEvent = sandbox.onEvent((event) => {
    // Only forward committed write events. Request/listener/lifecycle
    // events are local observational artifacts, not replayable state.
    if (event.kind !== 'write') return;

    // ECHO/LOOP SUPPRESSION — primary guard. If we are currently applying
    // a remote write, the `kind:'write'` event we receive here is the
    // downstream effect of that apply (the LocalEnvironment emitting a write
    // event for the admin set/delete). We MUST NOT re-broadcast it.
    if (applyingRemote) return;

    const msg: WriteMessage = { kind: 'write', origin: originId, event };
    channel.postMessage(msg);
  });

  // ── Channel message listener: receive and apply remote writes ────────

  const handleMessage = (ev: { data: unknown }): void => {
    if (!isTabSyncMessage(ev.data)) return;
    const msg = ev.data;

    // ECHO SUPPRESSION — secondary guard. The BroadcastChannel spec does
    // NOT deliver messages to the sender (it's broadcast-to-others by spec),
    // but injected test channels may differ. Filtering here makes the logic
    // correct regardless of channel semantics.
    if (msg.origin === originId) return;

    if (msg.kind === 'write') {
      applyRemoteWrite(msg.event);
    } else if (msg.kind === 'hello') {
      // A new tab joined and wants our current state. Reply with a snapshot
      // addressed specifically to it (`to: msg.origin`) so only that tab
      // applies it. All other tabs that receive this `state` message will
      // see `to !== their originId` and ignore it.
      const reply: StateMessage = {
        kind: 'state',
        origin: originId,
        to: msg.origin,
        snapshot: sandbox.snapshot(),
      };
      channel.postMessage(reply);
    } else if (msg.kind === 'state') {
      // Only apply a `state` snapshot if:
      //   (a) It was addressed to us.
      //   (b) We haven't already applied a state in this enable() session.
      //   (c) Our local Firestore store is currently empty (we're a fresh tab).
      //
      // Condition (c) prevents a second state reply from overwriting a tab
      // that has already accumulated its own writes after the first state
      // was applied. It also ensures an active tab that calls enableTabSync
      // mid-session doesn't lose its own data to a peer's snapshot.
      if (msg.to !== originId) return;
      if (stateApplied) return;

      const localFirestoreDocs = Object.keys(sandbox.snapshot().firestore);
      if (localFirestoreDocs.length > 0) {
        // Tab already has data — don't clobber it. We still mark
        // stateApplied so further state messages are ignored.
        stateApplied = true;
        return;
      }

      // Apply the remote snapshot's Firestore docs under the re-entrancy
      // guard so the resulting admin-write events are not re-broadcast.
      applyingRemote = true;
      try {
        for (const [path, data] of Object.entries(msg.snapshot.firestore)) {
          sandbox.admin.setDocument(path, data as Record<string, unknown>);
        }
      } finally {
        applyingRemote = false;
      }
      stateApplied = true;
    }
  };

  channel.addEventListener('message', handleMessage);

  // ── Late-join hello ───────────────────────────────────────────────────
  //
  // Broadcast a `hello` immediately after wiring up the message listener.
  // Other tabs that receive it will reply with `state`. We process the
  // reply in `handleMessage` above. The hello fires AFTER the listener is
  // registered to avoid a race where the state reply arrives before we
  // start listening (even though BroadcastChannel is async microtask-like
  // in browsers, the test channel may be synchronous — ordering matters).
  const helloMsg: HelloMessage = { kind: 'hello', origin: originId };
  channel.postMessage(helloMsg);

  // ── Disable function ──────────────────────────────────────────────────

  return () => {
    unsubscribeOnEvent();
    channel.removeEventListener('message', handleMessage);
    // Only close the channel when we created it. If the caller supplied
    // their own channel, they own its lifecycle.
    if (channelOwnedByUs) {
      channel.close();
    }
  };

  // ── Inner: apply a remote write to the local env ─────────────────────

  function applyRemoteWrite(event: WriteSandboxEvent): void {
    // Apply under the re-entrancy guard so the resulting onEvent emission
    // (from adminSetDocument → notifyListenersForPaths → SandboxImpl.emit)
    // is NOT re-broadcast. This is the loop-breaking mechanism.
    //
    // WHY admin path: the write was already authorized by the originating tab's
    // rules engine. Applying it as admin on the receiving tab bypasses rules on
    // the write side, which is correct — we're replicating a committed write.
    // Read-side rules are NOT bypassed: the `notifyListenersForPaths` call
    // triggered by `adminSetDocument`/`adminDeleteDocument` re-evaluates each
    // snapshot listener under ITS OWN registered auth identity (the listener's
    // `auth` field captured at subscribe time). So a listener that couldn't
    // read a document before still can't read it after the remote write — the
    // normal read-rules path applies.
    applyingRemote = true;
    try {
      if (event.method === 'delete') {
        sandbox.admin.deleteDocument(event.path);
      } else {
        // set / create / update — in all cases `nextState` is the post-
        // resolution document data we want the receiving tab to have.
        // We use setDocument (replace semantics) because `nextState` is
        // already the fully-resolved final state; we don't need to re-merge.
        const data = event.nextState;
        if (data !== null && data !== undefined) {
          sandbox.admin.setDocument(event.path, data as Record<string, unknown>);
        }
      }
    } finally {
      applyingRemote = false;
    }
  }
}
