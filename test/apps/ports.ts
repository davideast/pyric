/**
 * Loopback port allocation for app scenarios.
 *
 * Probing port 0 asks the kernel for a port in the OS ephemeral range
 * (32768-60999 on Linux, 49152-65535 on macOS and Windows). Outbound loopback
 * sockets and sibling scenario child processes that call `listen(0)` draw from
 * that same pool, so an ephemeral port can be claimed between closing the probe
 * socket and a Vite or sandbox child calling `listen(port)` (#2832). Probing
 * `[USER_PORT_MIN, USER_PORT_MAX]` stays above local service ports and strictly
 * below every OS ephemeral range.
 */
import { createServer } from 'node:net';

export const USER_PORT_MIN = 16_000;
export const USER_PORT_MAX = 31_999;

const USER_PORT_SPAN = USER_PORT_MAX - USER_PORT_MIN + 1;
const CANDIDATE_PROBES = 64;
const PORT_ATTEMPTS = 32;

let nextCursor = (process.pid * 131) % USER_PORT_SPAN;

type HostBindState = 'free' | 'busy' | 'unsupported';

function probeHostBind(port: number, host: string): Promise<HostBindState> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') {
        resolve('unsupported');
        return;
      }
      resolve('busy');
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve('free'));
    });
  });
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  const ipv4 = await probeHostBind(port, '127.0.0.1');
  if (ipv4 !== 'free') return false;
  const ipv6 = await probeHostBind(port, '::1');
  return ipv6 === 'free' || ipv6 === 'unsupported';
}

function probeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      let port = 0;
      if (typeof address === 'object' && address !== null) port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Finds an unused loopback port in `[USER_PORT_MIN, USER_PORT_MAX]`, falling
 * back to an OS-assigned port only if every probed candidate is occupied.
 */
export async function probePort(candidates?: Iterable<number>): Promise<number> {
  if (candidates !== undefined) {
    for (const candidate of candidates) {
      if (await canBindLoopbackPort(candidate)) return candidate;
    }
    return probeEphemeralPort();
  }
  for (let step = 0; step < CANDIDATE_PROBES; step += 1) {
    const candidate = USER_PORT_MIN + nextCursor;
    nextCursor = (nextCursor + 1) % USER_PORT_SPAN;
    if (await canBindLoopbackPort(candidate)) return candidate;
  }
  return probeEphemeralPort();
}

/** Hands out ports nothing listens on, never the same port twice. */
export interface PortIssuer {
  next(): Promise<number>;
}

/**
 * A probe closes its socket before the caller binds the port, so a later probe
 * could test that port again before the caller starts listening. The issuer
 * remembers every port it handed out and probes again on a repeat.
 */
export function portIssuer(probe: () => Promise<number> = probePort): PortIssuer {
  const issued = new Set<number>();
  return {
    async next() {
      const repeats: number[] = [];
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        const port = await probe();
        const isFresh = port > 0 && !issued.has(port);
        if (isFresh) {
          issued.add(port);
          return port;
        }
        repeats.push(port);
      }
      const seen = [...new Set(repeats)].join(', ');
      throw new Error(`no unissued port after ${PORT_ATTEMPTS} probes; the probe only returned ${seen}`);
    },
  };
}

/** The one issuer every app in a run shares, so concurrent apps never get the same port. */
export const runPorts = portIssuer();

/** A port nothing listens on that no earlier call in this run returned. */
export function freePort(issuer: PortIssuer = runPorts): Promise<number> {
  return issuer.next();
}

/** Whether a server child failed to bind `port` because another listener already held it. */
export function isAddressInUseOutput(output: string, port: number): boolean {
  if (output.includes(`Port ${port} is already in use`)) return true;
  return output.includes('EADDRINUSE') && output.includes(String(port));
}
