/**
 * Bridge presence subscription for Desktop Studio.
 *
 * Connects to the Pyric Bridge as an attached consumer (platform: 'studio'),
 * listens for `consumer-presence` broadcasts (connected mobile clients: Flutter,
 * iOS Swift, Android Kotlin), and exposes `setLens` to dispatch `remote-set-lens`
 * frames to the Bridge.
 */

import { useEffect, useRef, useState } from 'react';
import { useServeInit } from './serve-init.js';
import {
  toPageOriginWsUrl,
  type AuthLens,
  type BridgeMessage,
  type ConsumerPresenceFrame,
  type RemoteConsumerRecord,
} from '@pyric/cli/bridge/client';

export interface BridgeRemoteConsumersState {
  consumers: RemoteConsumerRecord[];
  connected: boolean;
  setLens: (clientSessionId: string, lens: AuthLens) => Promise<boolean>;
}

export function useBridgeRemoteConsumers(): BridgeRemoteConsumersState {
  const serve = useServeInit();
  const [consumers, setConsumers] = useState<RemoteConsumerRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingAcks = useRef<Map<string, (ok: boolean) => void>>(new Map());

  useEffect(() => {
    if (serve.status !== 'ready' || !serve.payload.bridgeUrl) {
      setConnected(false);
      setConsumers([]);
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let delayMs = 1_000;

    const loc = typeof window !== 'undefined' ? window.location : null;
    const url = loc ? toPageOriginWsUrl(serve.payload.bridgeUrl, loc) : serve.payload.bridgeUrl;

    function connect() {
      if (disposed) return;
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposed) {
            ws.close();
            return;
          }
          setConnected(true);
          delayMs = 1_000;
          try {
            ws.send(
              JSON.stringify({
                type: 'attach',
                protocol: 1,
                clientInfo: {
                  platform: 'studio',
                  deviceLabel: 'Desktop Studio',
                },
              }),
            );
          } catch {}
        };

        ws.onmessage = (event) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(event.data) as BridgeMessage;
            if (msg.type === 'consumer-presence') {
              const frame = msg as ConsumerPresenceFrame;
              const mobileClients = (frame.consumers || []).filter(
                (c: RemoteConsumerRecord) => c.platform !== 'studio',
              );
              setConsumers(mobileClients);
            } else if (msg.type === 'remote-set-lens-ack') {
              const ack = msg as { id?: string; ok: boolean };
              if (ack.id && pendingAcks.current.has(ack.id)) {
                const resolver = pendingAcks.current.get(ack.id);
                pendingAcks.current.delete(ack.id);
                resolver?.(ack.ok);
              }
            }
          } catch {}
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (disposed) return;
          setConnected(false);
          reconnectTimer = setTimeout(() => {
            delayMs = Math.min(delayMs * 1.5, 10_000);
            connect();
          }, delayMs);
        };

        ws.onerror = () => {};
      } catch {
        setConnected(false);
      }
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
      for (const resolver of pendingAcks.current.values()) {
        resolver(false);
      }
      pendingAcks.current.clear();
      setConnected(false);
    };
  }, [serve]);

  const setLens = async (clientSessionId: string, lens: AuthLens): Promise<boolean> => {
    setConsumers((prev) =>
      prev.map((c) =>
        c.clientSessionId === clientSessionId
          ? { ...c, activeLens: lens, lastSeen: Date.now() }
          : c,
      ),
    );

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const id = `lens-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.current.delete(id);
        resolve(true);
      }, 5_000);

      pendingAcks.current.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });

      try {
        ws.send(
          JSON.stringify({
            type: 'remote-set-lens',
            id,
            clientSessionId,
            lens,
          }),
        );
      } catch {
        clearTimeout(timer);
        pendingAcks.current.delete(id);
        resolve(false);
      }
    });
  };

  return { consumers, connected, setLens };
}
