/**
 * Bridge Consumer Registry — tracks active remote consumer sessions (mobile runtimes,
 * Studio tabs, Node clients) and manages presence broadcasting and remote lens routing.
 */

import type {
  AuthLens,
  BridgeMessage,
  ConsumerPresenceFrame,
  RemoteConsumerRecord,
} from '../protocol.js';
import { encodeBridgeMessage } from '../frame-output.js';
import type { SessionIdentityUpdate } from '../../auth/identity.js';

const PRESENCE_CAPACITY_MESSAGE = 'Consumer metadata exceeds the 12 MiB presence frame limit.';

export interface RegisteredConsumer {
  clientSessionId: string;
  platform: 'kotlin' | 'swift' | 'flutter' | 'node' | 'studio' | string;
  deviceLabel?: string;
  connectedAt: number;
  lastSeen: number;
  activeLens: AuthLens;
  send: (msg: BridgeMessage) => void;
}

export interface ConsumerRegistry {
  register(consumer: RegisteredConsumer): void;
  unregister(clientSessionId: string): RegisteredConsumer | undefined;
  touch(clientSessionId: string): void;
  setLens(clientSessionId: string, lens: AuthLens): SessionIdentityUpdate;
  get(clientSessionId: string): RegisteredConsumer | undefined;
  list(): RemoteConsumerRecord[];
  broadcastPresence(sendToPeer?: ((msg: BridgeMessage) => void) | null): void;
}

export function createConsumerRegistry(): ConsumerRegistry {
  const consumers = new Map<string, RegisteredConsumer>();

  function toRecord(c: RegisteredConsumer): RemoteConsumerRecord {
    return {
      clientSessionId: c.clientSessionId,
      platform: c.platform,
      deviceLabel: c.deviceLabel,
      connectedAt: c.connectedAt,
      lastSeen: c.lastSeen,
      activeLens: c.activeLens,
    };
  }

  function validatePresence(consumer: RegisteredConsumer): SessionIdentityUpdate {
    const records: RemoteConsumerRecord[] = [];
    for (const existing of consumers.values()) {
      const isReplacement = existing.clientSessionId === consumer.clientSessionId;
      if (isReplacement) continue;
      records.push(toRecord(existing));
    }
    records.push(toRecord(consumer));
    let payload: string | undefined;
    try {
      payload = encodeBridgeMessage({ type: 'consumer-presence', consumers: records });
    } catch (error) {
      const exceedsSerializationDepth = error instanceof RangeError;
      if (exceedsSerializationDepth) {
        return { ok: false, error: {
          code: 'resource-exhausted',
          message: 'Consumer metadata exceeds the serialization depth limit.',
        } };
      }
      throw error;
    }
    const exceedsCapacity = payload === undefined;
    if (exceedsCapacity) {
      return { ok: false, error: { code: 'resource-exhausted', message: PRESENCE_CAPACITY_MESSAGE } };
    }
    return { ok: true };
  }

  return {
    register(consumer: RegisteredConsumer): void {
      const result = validatePresence(consumer);
      const isRejected = !result.ok;
      if (isRejected) throw new Error(result.error.message);
      consumers.set(consumer.clientSessionId, consumer);
    },

    unregister(clientSessionId: string): RegisteredConsumer | undefined {
      const existing = consumers.get(clientSessionId);
      consumers.delete(clientSessionId);
      return existing;
    },

    touch(clientSessionId: string): void {
      const c = consumers.get(clientSessionId);
      const isRegistered = c !== undefined;
      if (isRegistered) c.lastSeen = Date.now();
    },

    setLens(clientSessionId: string, lens: AuthLens): SessionIdentityUpdate {
      const c = consumers.get(clientSessionId);
      const isUnknownConsumer = c === undefined;
      if (isUnknownConsumer) return { ok: false, error: { code: 'not-found', message: 'Client session not found' } };
      const updated = { ...c, activeLens: lens, lastSeen: Date.now() };
      const result = validatePresence(updated);
      const isRejected = !result.ok;
      if (isRejected) return result;
      c.activeLens = lens;
      c.lastSeen = updated.lastSeen;
      try {
        c.send({
          type: 'worker-event',
          event: 'remote-lens',
          clientSessionId,
          lens,
        });
      } catch {}
      return { ok: true };
    },

    get(clientSessionId: string): RegisteredConsumer | undefined {
      return consumers.get(clientSessionId);
    },

    list(): RemoteConsumerRecord[] {
      return Array.from(consumers.values()).map(toRecord);
    },

    broadcastPresence(sendToPeer?: ((msg: BridgeMessage) => void) | null): void {
      const records = Array.from(consumers.values()).map(toRecord);
      const frame: ConsumerPresenceFrame = {
        type: 'consumer-presence',
        consumers: records,
      };

      const hasPeer = sendToPeer !== undefined && sendToPeer !== null;
      if (hasPeer) {
        try {
          sendToPeer(frame);
        } catch {}
      }

      for (const c of consumers.values()) {
        const isStudio = c.platform === 'studio';
        if (isStudio) {
          try {
            c.send(frame);
          } catch {}
        }
      }
    },
  };
}
