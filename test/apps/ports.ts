import { createServer } from 'node:net';

/** Binds port 0 on loopback, reads the port the kernel chose, and closes it. */
export function probePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Hands out ports nothing listens on, never the same port twice. */
export interface PortIssuer {
  next(): Promise<number>;
}

const PORT_ATTEMPTS = 32;

/**
 * A probe closes its socket before the caller binds the port, so the kernel
 * can choose that port again for the next probe. The issuer remembers every
 * port it handed out and probes again on a repeat.
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
      throw new Error(`no unissued port after ${PORT_ATTEMPTS} probes; the probe only returned ${[...new Set(repeats)].join(', ')}`);
    },
  };
}

/** The one issuer every app in a run shares, so concurrent apps never get the same port. */
export const runPorts = portIssuer();

/** A port nothing listens on that no earlier call in this run returned. */
export function freePort(issuer: PortIssuer = runPorts): Promise<number> {
  return issuer.next();
}
