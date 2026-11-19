import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SocketDropInFlightFatesObservation } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-socket-drop-in-flight-fates.ts';

const OBSERVATION_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-modular',
  'rtdb-modular-socket-drop-in-flight-fates.json',
);

export function loadSocketDropObservation(): SocketDropInFlightFatesObservation {
  const parsed = JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as {
    behavior: SocketDropInFlightFatesObservation;
  };
  return parsed.behavior;
}

export async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface TrackedOutcome {
  settled: boolean;
  value: unknown;
  error: (Error & { code?: unknown }) | null;
}

export function trackOutcome(promise: Promise<unknown>): TrackedOutcome {
  const state: TrackedOutcome = {
    settled: false,
    value: undefined,
    error: null,
  };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (err: unknown) => {
      state.settled = true;
      if (err instanceof Error) {
        state.error = err as Error & { code?: unknown };
      } else {
        state.error = new Error(String(err));
      }
    },
  );
  return state;
}

export interface HostedFrameRecord {
  conn: number;
  kind: 'sub' | 'op';
  id: string;
  callId: string;
  method: string;
}

export interface RemoteFrameRecord {
  conn: number;
  kind: 'sub' | 'op';
  id: string;
  method: string;
  key: string | undefined;
}

export const RESEND_METHODS = [
  'rtdb.set',
  'rtdb.update',
  'rtdb.remove',
  'rtdb.setPriority',
  'rtdb.setWithPriority',
  'rtdb.push',
  'rtdb.get',
] as const;

export const FORGET_METHODS = [
  'rtdb.onDisconnectSet',
  'rtdb.onDisconnectUpdate',
  'rtdb.onDisconnectRemove',
  'rtdb.onDisconnectCancel',
] as const;
