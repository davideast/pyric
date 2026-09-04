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
      consumers.set(consumer.clientSessionId, consumer);
    },

    unregister(clientSessionId: string): RegisteredConsumer | undefined {
      const existing = consumers.get(clientSessionId);
      consumers.delete(clientSessionId);
      return existing;
    },

    touch(clientSessionId: string): void {
      const c = consumers.get(clientSessionId);
      if (c) c.lastSeen = Date.now();
    },

    setLens(clientSessionId: string, lens: AuthLens): boolean {
      const c = consumers.get(clientSessionId);
      if (!c) return false;
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

      if (sendToPeer) {
        try {
          sendToPeer(frame);
        } catch {}
      }

      for (const c of consumers.values()) {
        if (c.platform === 'studio') {
          try {
            c.send(frame);
          } catch {}
        }
      }
    },
  };
}
