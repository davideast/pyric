/**
 * Tracks still-open `@pyric/live` listener attaches per `ClientPort` so a
 * surviving browser tab or service worker re-emits its active attaches when
 * reattaching to a restarted host (`needsSessionRestore`).
 */
import type { ObservedCall } from 'pyric/sandbox';
import type { ObservedSessionDelta } from '../../observed-session/wire.js';
import type { InboundMessage } from '../protocol.js';
import { nextId } from './core.js';
import type { ClientPort } from './handles.js';

const ACTIVE_PORT_LISTENERS = new WeakMap<ClientPort, Map<string, ObservedCall>>();

export function buildObserveFrame(
  call: ObservedCall,
  script?: string,
  sessionData?: ObservedSessionDelta,
): Extract<InboundMessage, { t: 'observe' }> {
  const frame: Extract<InboundMessage, { t: 'observe' }> = {
    t: 'observe',
    id: nextId(),
    call,
  };
  if (script !== undefined) frame.script = script;
  if (sessionData !== undefined) frame.sessionData = sessionData;
  return frame;
}

export function trackObservedPortListener(
  port: ClientPort,
  call: ObservedCall,
  scriptOf: () => string | undefined,
): void {
  const listener = call.listener;
  if (listener === undefined) return;
  let active = ACTIVE_PORT_LISTENERS.get(port);
  if (active === undefined) {
    active = new Map();
    ACTIVE_PORT_LISTENERS.set(port, active);
    const tracked = active;
    port.restoreObservedListeners = (request) => {
      const script = scriptOf();
      for (const attachCall of tracked.values()) {
        void request(buildObserveFrame(attachCall, script)).catch(() => undefined);
      }
    };
  }
  if (listener.phase === 'attach') {
    active.set(listener.id, call);
  } else {
    active.delete(listener.id);
  }
}
