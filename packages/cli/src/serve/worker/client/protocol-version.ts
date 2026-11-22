/**
 * Peer worker-protocol version negotiation for Firestore `databaseId` frames
 * (ADR-0021 Decision 4).
 *
 * `(default)` frames never wait on handshake. Named-database frames wait for
 * the peer's `workerProtocol` version (defaulting to 1 when absent or on a 2s
 * handshake timeout) and reject protocol-1 peers with `failed-precondition`
 * before sending the frame.
 */
import { FirebaseError } from 'pyric/app';
import { WORKER_PROTOCOL_VERSION } from '../protocol.js';
import { nextId, rpcWithTimeout } from './core.js';
import type { ClientPort } from './handles.js';

declare const __PYRIC_WORKER_VERSION__: string | undefined;

const VERSION_PROBE_TIMEOUT_MS = 2_000;
const FALLBACK_CLI_VERSION = '0.1.0-alpha.35';

const resolvedProtocolByPort = new WeakMap<ClientPort, number>();
const inFlightProbeByPort = new WeakMap<ClientPort, Promise<number>>();
const hostUrlByPort = new WeakMap<ClientPort, string>();

export function setPortHostUrl(port: ClientPort, url: string): void {
  if (url.length > 0) {
    hostUrlByPort.set(port, url);
  }
}

function getPortHostUrl(port: ClientPort): string {
  const explicit = hostUrlByPort.get(port);
  if (explicit !== undefined) return explicit;
  if (port.byteRoute?.baseUrl) return port.byteRoute.baseUrl;
  return 'worker';
}

export function recordPeerWorkerProtocol(port: ClientPort, version: number | undefined): void {
  let resolved = 1;
  if (typeof version === 'number' && Number.isFinite(version)) {
    resolved = version;
  }
  resolvedProtocolByPort.set(port, resolved);
}

async function probePeerWorkerProtocol(port: ClientPort): Promise<number> {
  try {
    const reply = (await rpcWithTimeout(
      port,
      { t: 'op', id: nextId(), method: 'getRuntimeEpoch' },
      VERSION_PROBE_TIMEOUT_MS,
      'Timed out waiting for Pyric worker protocol handshake.',
    )) as { workerProtocol?: unknown } | null;
    const wp = reply?.workerProtocol;
    if (typeof wp === 'number' && Number.isFinite(wp)) {
      return wp;
    }
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Unknown method: getRuntimeEpoch')) {
      try {
        const fallback = (await rpcWithTimeout(
          port,
          { t: 'op', id: nextId(), method: 'getVersion' },
          VERSION_PROBE_TIMEOUT_MS,
          'Timed out waiting for Pyric worker version handshake.',
        )) as { workerProtocol?: unknown } | null;
        const wp = fallback?.workerProtocol;
        if (typeof wp === 'number' && Number.isFinite(wp)) {
          return wp;
        }
      } catch {
        return 1;
      }
    }
    return 1;
  }
}

function getPeerWorkerProtocol(port: ClientPort): Promise<number> {
  const known = resolvedProtocolByPort.get(port);
  if (known !== undefined) {
    return Promise.resolve(known);
  }
  const existingProbe = inFlightProbeByPort.get(port);
  if (existingProbe !== undefined) {
    return existingProbe;
  }
  const probe = probePeerWorkerProtocol(port).then((version) => {
    resolvedProtocolByPort.set(port, version);
    inFlightProbeByPort.delete(port);
    return version;
  });
  inFlightProbeByPort.set(port, probe);
  return probe;
}

function cliVersionLabel(): string {
  if (
    typeof __PYRIC_WORKER_VERSION__ === 'string' &&
    __PYRIC_WORKER_VERSION__.length > 0 &&
    __PYRIC_WORKER_VERSION__ !== 'dev'
  ) {
    return __PYRIC_WORKER_VERSION__;
  }
  return FALLBACK_CLI_VERSION;
}

function protocolOneDatabaseIdError(hostUrl: string, databaseId: string): FirebaseError {
  return new FirebaseError(
    'failed-precondition',
    `pyric: the host at ${hostUrl} speaks worker protocol 1, which has no Firestore database ids. ` +
      `Restart it with @pyric/cli ${cliVersionLabel()} or later to use getFirestore(app, "${databaseId}").`,
  );
}

export async function ensurePeerSupportsDatabaseId(
  port: ClientPort,
  databaseId: string | undefined,
): Promise<void> {
  if (databaseId === undefined || databaseId === '' || databaseId === '(default)') {
    return;
  }
  const peerProtocol = await getPeerWorkerProtocol(port);
  if (peerProtocol < WORKER_PROTOCOL_VERSION) {
    throw protocolOneDatabaseIdError(getPortHostUrl(port), databaseId);
  }
}
