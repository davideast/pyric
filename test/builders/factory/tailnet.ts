/**
 * Putting the served copy's port on a private network with Tailscale:
 * `tailscale serve --bg --https=<port>` gives `https://<host>:<port>`, where
 * the host is this machine's name on that network. The Tailscale CLI is the
 * one `PYRIC_FACTORY_TAILSCALE` names; without it nothing is published and
 * the served copy stays on the address it listens on (`serve-host.ts`).
 * `PYRIC_FACTORY_TAILNET_HOST` names the host when `tailscale status` can't.
 *
 * Only the entries this run added are recorded, and only those are removed
 * when the run ends; an entry the machine already had is left as it is.
 */
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { hostInUrl, LOOPBACK } from './serve-host.ts';

const TIMEOUT_MS = 30_000;

export interface TailscaleResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Tailscale = (args: readonly string[]) => TailscaleResult;

/** The Tailscale CLI `PYRIC_FACTORY_TAILSCALE` names, when it names one. */
export function tailscaleFrom(env: NodeJS.ProcessEnv = process.env): Tailscale | undefined {
  const binary = env.PYRIC_FACTORY_TAILSCALE;
  if (binary === undefined || binary === '') return undefined;
  return (args) => {
    const result = spawnSync(binary, [...args], { encoding: 'utf8', timeout: TIMEOUT_MS });
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

const statusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }).passthrough().optional(),
}).passthrough();

/** The machine's name on the private network, without the trailing dot; undefined unless Tailscale is running and says. */
export function tailnetHost(env: NodeJS.ProcessEnv = process.env, tailscale: Tailscale | undefined = tailscaleFrom(env)): string | undefined {
  const configured = env.PYRIC_FACTORY_TAILNET_HOST;
  if (configured !== undefined && configured !== '') return configured;
  if (tailscale === undefined) return undefined;
  const status = tailscale(['status', '--json']);
  if (!status.ok) return undefined;
  let parsed: z.infer<typeof statusSchema>;
  try {
    parsed = statusSchema.parse(JSON.parse(status.stdout));
  } catch {
    return undefined;
  }
  if (parsed.BackendState !== 'Running') return undefined;
  const name = parsed.Self?.DNSName.replace(/\.$/, '') ?? '';
  return name === '' ? undefined : name;
}

export function tailnetUrl(port: number, host: string): string {
  return `https://${host}:${port}/`;
}

/** Whether `tailscale serve status` lists an entry for `port`. */
export function hasServeEntry(status: string, port: number): boolean {
  return new RegExp(`https://\\S+:${port}\\b`).test(status);
}

export interface Published {
  lines: string[];
  /** The ports this call added an entry for. */
  added: number[];
}

/** Serves each port on the private network unless it already is, proxied to that port on `host`. */
export function ensureServed(ports: readonly number[], tailscale: Tailscale | undefined, host: string = LOOPBACK): Published {
  if (tailscale === undefined) return { lines: ['PYRIC_FACTORY_TAILSCALE is not set; the served copy is on its own address only'], added: [] };
  const status = tailscale(['serve', 'status']).stdout;
  const lines: string[] = [];
  const added: number[] = [];
  for (const port of ports) {
    if (hasServeEntry(status, port)) {
      lines.push(`${port}: already served on the private network`);
      continue;
    }
    const result = tailscale(['serve', '--bg', `--https=${port}`, `http://${hostInUrl(host)}:${port}`]);
    if (!result.ok) {
      lines.push(`${port}: tailscale serve failed: ${result.stderr.trim()}`);
      continue;
    }
    added.push(port);
    lines.push(`${port}: now served on the private network`);
  }
  return { lines, added };
}

/** Removes the entries for `ports`. */
export function removeServed(ports: readonly number[], tailscale: Tailscale | undefined): string[] {
  if (tailscale === undefined) return ports.map((port) => `${port}: PYRIC_FACTORY_TAILSCALE is not set; the entry is left`);
  return ports.map((port) => {
    const result = tailscale(['serve', `--https=${port}`, 'off']);
    if (!result.ok) return `${port}: tailscale serve off failed: ${result.stderr.trim()}`;
    return `${port}: removed from the private network`;
  });
}
