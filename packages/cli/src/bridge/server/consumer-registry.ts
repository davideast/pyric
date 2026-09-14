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
  setLens(clientSessionId: string, lens: AuthLens): boolean;
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

  return {
    register(consumer: RegisteredConsumer): void {
      const records: RemoteConsumerRecord[] = [];
      for (const existing of consumers.values()) {
        const isReplacement = existing.clientSessionId === consumer.clientSessionId;
        if (isReplacement) continue;
        records.push(toRecord(existing));
      }
      records.push(toRecord(consumer));
      const presence: ConsumerPresenceFrame = { type: 'consumer-presence', consumers: records };
      const exceedsFrameLimit = encodeBridgeMessage(presence) === undefined;
      if (exceedsFrameLimit) throw new Error('Consumer metadata exceeds the 12 MiB presence frame limit.');
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

    setLens(clientSessionId: string, lens: AuthLens): boolean {
      const c = consumers.get(clientSessionId);
      const isUnknownConsumer = c === undefined;
      if (isUnknownConsumer) return false;
      c.activeLens = lens;
      c.lastSeen = Date.now();
      try {
        c.send({
          type: 'worker-event',
          event: 'remote-lens',
          clientSessionId,
          lens,
        });
      } catch {}
      return true;
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
