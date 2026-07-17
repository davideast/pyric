/** Canonical provenance stamping and nested-window composition. */

import type {
  EventProvenance,
  OperationContext,
  SandboxEvent,
} from '../types/events.js';
import {
  immutableOperationContext,
  isOperationEvent,
  resolveOperationContext,
  rulesDispositionFor,
} from '../operation-record.js';

/** Stamp canonical context and Rules disposition at the unified event seam. */
export function stampProvenance<E extends SandboxEvent>(
  event: E,
  overrides?: EventProvenance,
): E {
  const out = { ...event } as E & EventProvenance;
  out.service = event.service ?? overrides?.service ?? 'firestore';

  // Pre-context admin events used `detail.admin` as their only execution-lens
  // marker. Normalize that one legacy shape here; new producers bind context.
  const legacyAdmin = 'detail' in event && event.detail?.admin === true;
  const executed: EventProvenance = legacyAdmin
    && event.operationContext === undefined
    && event.authLens === undefined
    ? { ...event, authLens: { mode: 'admin' } }
    : event;
  // Operation producers carry an execution context. Its auth lens describes
  // what reached the service, while the surrounding override identifies who
  // issued it. Legacy/lifecycle events predate that distinction and retain
  // their original per-field "event wins" behavior.
  const context = isOperationEvent(out) || event.operationContext !== undefined
    ? resolveOperationContext(overrides, executed)
    : legacyEventContext(event, overrides);

  out.operationContext = context;
  out.actor = context.source;
  out.authLens = context.authLens;
  if (context.planId !== undefined) out.planId = context.planId;
  if (overrides?.activityListenerId !== undefined) {
    out.activityListenerId = overrides.activityListenerId;
  }
  if (overrides?.activityListenerLifecycle !== undefined) {
    out.activityListenerLifecycle = overrides.activityListenerLifecycle;
  }
  if (overrides?.activityGroupKind !== undefined) {
    out.activityGroupKind = overrides.activityGroupKind;
  }
  if (isOperationEvent(out)) {
    out.rulesDisposition = Object.freeze({ ...rulesDispositionFor(out) });
  }
  return out;
}

function legacyEventContext(
  event: EventProvenance,
  overrides: EventProvenance | undefined,
): OperationContext {
  return immutableOperationContext({
    source:
      event.actor
      ?? event.operationContext?.source
      ?? overrides?.actor
      ?? overrides?.operationContext?.source
      ?? { kind: 'unattributed' },
    authLens:
      event.authLens
      ?? event.operationContext?.authLens
      ?? overrides?.authLens
      ?? overrides?.operationContext?.authLens
      ?? { mode: 'app-session' },
    ...((event.planId
      ?? event.operationContext?.planId
      ?? overrides?.planId
      ?? overrides?.operationContext?.planId) === undefined
      ? {}
      : {
          planId:
            event.planId
            ?? event.operationContext?.planId
            ?? overrides?.planId
            ?? overrides?.operationContext?.planId,
        }),
  });
}

/** Merge two nested ambient declarations. This is deliberately different
 * from issue/execution composition: the innermost ambient window wins each
 * field, preserving the public `runWithProvenance` contract. */
export function mergeAmbientProvenance(
  outer: EventProvenance | undefined,
  inner: EventProvenance | undefined,
): EventProvenance | undefined {
  if (!outer) return inner;
  if (!inner) return outer;

  // A complete context marks an adapter execution boundary rather than an
  // ordinary nested ambient declaration. Preserve the outer issuer while
  // taking the lens that the bound handle actually executed with.
  if (inner.operationContext !== undefined) {
    return mergeProvenance(outer, inner);
  }

  const hasContext =
    outer.operationContext !== undefined
    || outer.actor !== undefined
    || outer.authLens !== undefined
    || outer.planId !== undefined
    || inner.actor !== undefined
    || inner.authLens !== undefined
    || inner.planId !== undefined;
  if (!hasContext) return { ...outer, ...inner };

  const context = immutableOperationContext({
    source:
      inner.actor
      ?? outer.operationContext?.source
      ?? outer.actor
      ?? { kind: 'unattributed' },
    authLens:
      inner.authLens
      ?? outer.operationContext?.authLens
      ?? outer.authLens
      ?? { mode: 'app-session' },
    ...((inner.planId
      ?? outer.operationContext?.planId
      ?? outer.planId) === undefined
      ? {}
      : {
          planId:
            inner.planId
            ?? outer.operationContext?.planId
            ?? outer.planId,
        }),
  });
  return {
    ...outer,
    ...inner,
    operationContext: context,
    actor: context.source,
    authLens: context.authLens,
    ...(context.planId === undefined ? {} : { planId: context.planId }),
  };
}

/**
 * Merge nested provenance windows by domain role. The outer window is the
 * issue-time declaration (source/plan); the inner window is the execution
 * handle (auth lens). This prevents a prebuilt app/unattributed handle from
 * erasing a Studio issuer while still recording the lens that actually ran.
 */
export function mergeProvenance(
  issued: EventProvenance | undefined,
  executed: EventProvenance | undefined,
): EventProvenance | undefined {
  if (!issued) return executed;
  if (!executed) return issued;

  const hasContext =
    issued.operationContext !== undefined
    || issued.actor !== undefined
    || issued.authLens !== undefined
    || issued.planId !== undefined
    || executed.operationContext !== undefined
    || executed.actor !== undefined
    || executed.authLens !== undefined
    || executed.planId !== undefined;
  if (!hasContext) return { ...issued, ...executed };

  const context = resolveOperationContext(issued, executed);
  return {
    ...issued,
    ...executed,
    operationContext: context,
    actor: context.source,
    authLens: context.authLens,
    ...(context.planId === undefined ? {} : { planId: context.planId }),
  };
}
