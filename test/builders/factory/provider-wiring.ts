/**
 * The run's provider channel, wired in: `factory --provider-keys <file>`.
 *
 * The supervisor starts one provider forwarder per caller kind, sessions and
 * the served copy, in its own process, sharing one ledger object so the two
 * can never spend the cap twice. Each listens on its own socket under
 * `<run>.host/provider/`, bound read-only into that caller's sandbox and
 * none into the check's. Inside, a bridge pipes 127.0.0.1:4180 to the
 * socket, and the app's client is pointed there with a placeholder key
 * (`providerEnvironment`). The key is read from its file per call, in the
 * forwarder, and reaches nothing else.
 *
 * At a cap the forwarder refuses calls and the run goes on: one
 * `provider-cap` timeline line and one journal line per cap reached.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Listening } from '../model-channel.ts';
import { hostDirOf, makeHostDir } from './host-files.ts';
import { readProviderKey } from './provider-keys.ts';
import { PLACEHOLDER_KEY, startProviderForwarder, type ProviderCall, type ProviderUpstream } from './provider-forwarder.ts';
import { openProviderLedger, type CallerKind, type LedgerRefusal, type ProviderLedger } from './provider-ledger.ts';
import { priceOf } from './provider-prices.ts';

/** What sessions and the served copy may spend between them. */
export const PROVIDER_CAP_USD = 50;
/** What sessions may spend of it, so the served build keeps budget. */
export const SESSION_PROVIDER_CAP_USD = 15;
/** The bridge's port on a sandbox's loopback; the app's base URL names it. */
export const PROVIDER_BRIDGE_PORT = 4180;

/** The env a provider-enabled sandbox's app gets in place of fake media: routes on, client pointed at the bridge. No secret. */
export function providerEnvironment(): Record<string, string> {
  return { GEMINI_API_KEY: PLACEHOLDER_KEY, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${PROVIDER_BRIDGE_PORT}` };
}

export interface ProviderFiles {
  dir: string;
  spend: string;
  calls: string;
  config: string;
  socket: (caller: CallerKind) => string;
}

export function providerFiles(runDir: string): ProviderFiles {
  const dir = join(hostDirOf(runDir), 'provider');
  return {
    dir,
    spend: join(dir, 'spend.jsonl'),
    calls: join(dir, 'calls.jsonl'),
    config: join(dir, 'config.json'),
    socket: (caller) => join(dir, `${caller}.sock`),
  };
}

/** Which cap a refusal hit, and what it was. */
export interface CapReached {
  scope: 'run' | 'session';
  capUsd: number;
}

export interface ProviderChannelOptions {
  runDir: string;
  /** The key file's path; the key is read from it per call. */
  keyFile: string;
  capUsd?: number;
  sessionCapUsd?: number;
  /** Told once per cap, the first time a call is refused at it. */
  onCap: (cap: CapReached) => void;
  onFault?: (reason: string) => void;
  /** Test seam: where calls go instead of the provider's host. */
  upstream?: ProviderUpstream;
  now?: () => Date;
}

export interface ProviderChannel {
  /** The socket each caller kind's sandbox gets, read-only. */
  socket(caller: CallerKind): string;
  close(): Promise<void>;
}

/** The journal line for a cap reached. */
export function capLine(cap: CapReached): string {
  const usd = cap.capUsd.toFixed(2);
  return cap.scope === 'run'
    ? `provider spend reached $${usd}; provider calls are refused`
    : `session provider spend reached $${usd}; session provider calls are refused`;
}

function capScope(refusal: LedgerRefusal, caller: CallerKind): CapReached['scope'] | undefined {
  if (refusal === 'run-cap') return 'run';
  const isSessionCap = refusal === 'caller-cap' && caller === 'session';
  return isSessionCap ? 'session' : undefined;
}

/** `ledger`, telling `onCap` once per cap the first time a reservation is refused at it. */
function capWatched(ledger: ProviderLedger, options: Pick<ProviderChannelOptions, 'onCap'>, caps: { run: number; session: number }): ProviderLedger {
  const told = new Set<CapReached['scope']>();
  const tell = (refusal: LedgerRefusal, caller: CallerKind) => {
    const scope = capScope(refusal, caller);
    if (scope === undefined || told.has(scope)) return;
    told.add(scope);
    options.onCap({ scope, capUsd: caps[scope] });
  };
  return {
    capUsd: ledger.capUsd,
    problem: () => ledger.problem(),
    spentUsd: () => ledger.spentUsd(),
    spentBy: (caller) => ledger.spentBy(caller),
    inFlight: () => ledger.inFlight(),
    reserve: (caller, model, usd) => {
      const reserved = ledger.reserve(caller, model, usd);
      if (typeof reserved === 'string') tell(reserved, caller);
      return reserved;
    },
  };
}

/** Clears a socket a stopped supervisor left, so a resumed run can listen again. Never anything but a socket. */
function clearStaleSocket(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSocket() === true) unlinkSync(path);
}

/** Starts both forwarders on the run's one ledger. */
export async function startProviderChannel(options: ProviderChannelOptions): Promise<ProviderChannel> {
  const files = providerFiles(options.runDir);
  const host = hostDirOf(options.runDir);
  makeHostDir(host, host, options.runDir);
  makeHostDir(files.dir, host, options.runDir);
  const caps = { run: options.capUsd ?? PROVIDER_CAP_USD, session: Math.min(options.sessionCapUsd ?? SESSION_PROVIDER_CAP_USD, options.capUsd ?? PROVIDER_CAP_USD) };
  writeFileSync(files.config, `${JSON.stringify({ capUsd: caps.run, sessionCapUsd: caps.session })}\n`, { mode: 0o600 });
  const opened = openProviderLedger({ path: files.spend, capUsd: caps.run, callerCapsUsd: { session: caps.session }, ...(options.now === undefined ? {} : { now: options.now }) });
  const ledger = capWatched(opened, options, caps);
  const listening: Listening[] = [];
  const callers: CallerKind[] = ['session', 'served'];
  try {
    for (const caller of callers) {
      clearStaleSocket(files.socket(caller));
      listening.push(await startProviderForwarder({
        socketPath: files.socket(caller),
        caller,
        ledger,
        calls: files.calls,
        credential: () => readProviderKey(options.keyFile),
        ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.onFault === undefined ? {} : { onFault: options.onFault }),
      }));
    }
  } catch (error) {
    await Promise.all(listening.map((server) => server.close()));
    throw error;
  }
  return {
    socket: (caller) => files.socket(caller),
    close: async () => {
      await Promise.all(listening.map((server) => server.close()));
    },
  };
}

function readCalls(path: string): ProviderCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((text) => {
    try {
      return text.trim() === '' ? [] : [JSON.parse(text) as ProviderCall];
    } catch {
      return [];
    }
  });
}

/** `provider spend $X of $50 (N images, M music, R refused)`, or undefined when the run has no provider channel. */
export function providerSpendLine(runDir: string): string | undefined {
  const files = providerFiles(runDir);
  if (!existsSync(files.config)) return undefined;
  const { capUsd } = JSON.parse(readFileSync(files.config, 'utf8')) as { capUsd: number };
  const calls = readCalls(files.calls);
  const billed = calls.filter((call) => call.chargedUsd > 0);
  const spent = billed.reduce((total, call) => total + call.chargedUsd, 0);
  const kindCount = (kind: string) => billed.filter((call) => call.model !== null && priceOf(call.model)?.kind === kind).length;
  const refused = calls.filter((call) => call.action === 'refused').length;
  return `provider spend $${spent.toFixed(2)} of $${capUsd.toFixed(0)} (${kindCount('image')} images, ${kindCount('music')} music, ${refused} refused)`;
}
