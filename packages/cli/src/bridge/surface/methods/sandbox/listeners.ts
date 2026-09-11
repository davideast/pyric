/**
 * Every listener the sandbox currently holds attached, across Firestore and
 * the Realtime Database, folded from the event stream rather than tracked as
 * separate live state.
 */
import { z } from 'zod';
import {
  activeListeners,
  activeListenerTargetStartsWith,
  type ActiveListener,
} from 'pyric/sandbox';
import type { MethodRecord } from '../../method-types.js';

const SERVICES = ['firestore', 'database'] as const;

/** One active listener, as this method reports it. */
function listenerView(listener: ActiveListener): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: listener.id,
    service: listener.service,
    target: listener.target,
    actor: listener.actor,
    authLens: listener.authLens,
    attachedAt: listener.attachedAt,
    deliveryCount: listener.deliveryCount,
    suppressedCount: listener.suppressedCount,
  };
  if (listener.lastDeliveryAt !== undefined) view.lastDeliveryAt = listener.lastDeliveryAt;
  if (listener.callSite !== undefined) view.callSite = listener.callSite;
  return view;
}

/** Totals per service, over exactly the listeners a call returns. */
function totalsFor(listeners: readonly ActiveListener[]): Record<string, number> {
  const totals: Record<string, number> = { firestore: 0, database: 0 };
  for (const listener of listeners) totals[listener.service] += 1;
  return totals;
}

export default {
  tool: 'sandbox',
  method: 'listeners',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `listeners(service?: ${SERVICES.join('|')}, target?)`,
  description: 'List every attached listener, with delivery and suppression counts.',
  args: z.object({
    service: z.enum(SERVICES).optional().describe('Narrow to one service.'),
    target: z.string().optional().describe('Keep only listeners whose target starts with this.'),
  }),
  operation: 'list_sandbox_listeners',
  example: {},
  async handler(args, ctx) {
    const service = typeof args.service === 'string' ? args.service : undefined;
    const target = typeof args.target === 'string' ? args.target : undefined;

    let listeners = activeListeners(ctx.sandbox.history());
    if (service !== undefined) {
      listeners = listeners.filter((listener) => listener.service === service);
    }
    if (target !== undefined) {
      listeners = listeners.filter((listener) => activeListenerTargetStartsWith(listener.target, target));
    }

    return {
      ok: true,
      summary: `${listeners.length} listener(s).`,
      data: {
        listeners: listeners.map(listenerView),
        totals: totalsFor(listeners),
      },
    };
  },
} satisfies MethodRecord;
