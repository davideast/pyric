/**
 * One-time subscription to `sandbox.onRequest` for the playground.
 * Every simulator op routes here — allows, denies, and unsupported.
 *
 *   - All events push into `runtime.traffic` (5000-event ring
 *     buffer) for the Traffic panel.
 *   - Denial events also push a classified `DenialBlurb` into
 *     `runtime.liveDenials` for the alarm UI + Analyze panel. The
 *     blurb's `id` equals the `RequestEvent.id` so the Traffic row
 *     can cross-reference its overlay state.
 *
 * Was `useDenialCapture`. Kept the file name to avoid touching all
 * the imports — the hook name remains too, even though it captures
 * more than denials now. The internal subscription is the only
 * shape change.
 *
 * Subscriber callbacks are synchronous; heavy work would inflate
 * the *next* op's `evalMs`. We push to the zustand store directly
 * (cheap) and defer classification (regex over app source) to
 * `queueMicrotask` for the denial path — keeps the hot path tight.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  getPlaygroundRuntime,
  getPlaygroundSandboxMode,
  subscribePlaygroundSandboxMode,
} from '~/lib/sandbox/runtime';
import { useRuntimeStore, type DenialBlurb, type TrafficEntry } from '~/lib/store/runtime';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { classifyAppDenials } from '~/lib/preview/denial-classifier';
import type { RequestEvent, SandboxOperationEvent } from 'pyric/sandbox';

type CapturedTrafficEvent = RequestEvent | SandboxOperationEvent;

function eventService(ev: CapturedTrafficEvent): string {
  return 'service' in ev && typeof ev.service === 'string' ? ev.service : 'firestore';
}

/**
 * Approx-cap on the JSON size of a `resourceData` payload retained
 * in the ring buffer. The probe data flagged that 1 MB doc writes
 * × 5000 cap = 5 GB heap; we truncate past this so worst case stays
 * bounded. 16 KB is generous for normal user docs and small enough
 * to keep the panel responsive.
 */
const RESOURCE_DATA_CAP_BYTES = 16 * 1024;

function shrinkData<T>(
  data: T,
): { value: T; truncated: boolean } {
  if (data === null || data === undefined) return { value: data, truncated: false };
  try {
    const json = JSON.stringify(data);
    if (json.length <= RESOURCE_DATA_CAP_BYTES) {
      return { value: data, truncated: false };
    }
    return {
      value: {
        __truncated: true,
        __originalSize: json.length,
        __preview: json.slice(0, RESOURCE_DATA_CAP_BYTES) + '…',
      } as unknown as T,
      truncated: true,
    };
  } catch {
    return { value: data, truncated: false };
  }
}

function shrinkTrafficEvent(ev: CapturedTrafficEvent): TrafficEntry {
  let truncated = false;
  const next: TrafficEntry = { ...ev };
  const requestData = ev.request?.resourceData ?? ('data' in (ev.request ?? {}) ? ev.request?.data : undefined);
  if (requestData !== undefined) {
    const out = shrinkData(requestData);
    next.request = { ...ev.request, resourceData: out.value };
    truncated = truncated || out.truncated;
  }
  if (ev.resourceBefore) {
    const out = shrinkData(ev.resourceBefore.data);
    next.resourceBefore = { ...ev.resourceBefore, data: out.value };
    truncated = truncated || out.truncated;
  }
  if (ev.resourceAfter) {
    const out = shrinkData(ev.resourceAfter.data);
    next.resourceAfter = { ...ev.resourceAfter, data: out.value };
    truncated = truncated || out.truncated;
  }
  if (truncated) next.truncated = true;
  return next;
}

function describeOp(ev: CapturedTrafficEvent): string {
  const service = eventService(ev);
  return `${service !== 'firestore' ? `${service}:` : ''}${ev.method} ${ev.path ?? '(service)'}`;
}

function describeAuth(ev: CapturedTrafficEvent): string {
  if (ev.auth === null || ev.auth === undefined) return 'null';
  try {
    return JSON.stringify(ev.auth);
  } catch {
    return String(ev.auth);
  }
}

/**
 * Project the `RequestEvent` into the same Firestore-rules-shape
 * canonical blob the old `useDenialCapture` produced for
 * `DenialBlurb.request` — keeps the existing drill-in copy /
 * Analyze prompt paths working unchanged.
 */
function buildRequestShape(ev: CapturedTrafficEvent): unknown {
  const request: Record<string, unknown> = {
    method: ev.method,
    path: ev.path ?? '(service)',
  };
  const requestData = ev.request?.resourceData ?? ('data' in (ev.request ?? {}) ? ev.request?.data : undefined);
  if (requestData !== undefined) {
    request.resource = { data: requestData };
  }
  if (ev.auth !== undefined) request.auth = ev.auth;

  const out: Record<string, unknown> = { request };
  if (ev.resourceBefore !== undefined) {
    out.resource = ev.resourceBefore;
  }
  if (ev.reasons && ev.reasons.length > 0) out.reasons = ev.reasons;
  return out;
}

export function useDenialCapture(): void {
  const pushTraffic = useRuntimeStore((s) => s.pushTraffic);
  const pushDenial = useRuntimeStore((s) => s.pushDenial);
  const sandboxMode = useSyncExternalStore(
    subscribePlaygroundSandboxMode,
    getPlaygroundSandboxMode,
    getPlaygroundSandboxMode,
  );

  useEffect(() => {
    const handleEvent = (event: { kind: string } | RequestEvent) => {
      // The traffic panel + denial alarm ride on canonical operation-like
      // events. Other kinds (snapshot_delivery, listener lifecycle,
      // session_boundary) are ignored here — separate consumers in the
      // playground handle those when they need to.
      if (event.kind !== 'request' && event.kind !== 'operation') return;
      const ev = event as CapturedTrafficEvent;

      // Hot path: shrink + push to the traffic buffer first so the
      // simulator's `evalMs` accounting doesn't include this work.
      pushTraffic(shrinkTrafficEvent(ev));

      if (ev.result !== 'deny') return;

      // Defer the regex-based classification (the slower step) so
      // the subscriber returns quickly. Subscriber callbacks are
      // synchronous; heavy work here inflates the next op's evalMs.
      queueMicrotask(() => {
        const appSource = useWorkspaceStore.getState().appSource;
        const { classification, reason } = classifyAppDenials(appSource);
        const blurb: DenialBlurb = {
          id: ev.id,
          at: ev.at,
          op: describeOp(ev),
          auth: describeAuth(ev),
          message:
            ev.reasons && ev.reasons.length > 0
              ? `denied by rules · ${JSON.stringify(ev.reasons)}`
              : 'denied by rules',
          request: buildRequestShape(ev),
          classification,
          classificationReason: reason,
        };
        pushDenial(blurb);
      });
    };

    return getPlaygroundRuntime().subscribeEvents((events) => {
      for (const event of events) handleEvent(event as CapturedTrafficEvent);
    });
  }, [pushTraffic, pushDenial, sandboxMode]);
}
