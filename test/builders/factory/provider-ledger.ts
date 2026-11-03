/**
 * The run's provider spend: what the provider forwarder has charged, kept so
 * a restart can't forget it. Sessions and the served copy share one cap
 * (`capUsd`), and each caller kind has its own cap inside it, so sessions
 * can't spend all of it (`callerCapsUsd.session`).
 *
 * The spend is metered by the round meter (`../model-meter.ts`): the run's
 * cap is the round's total and each caller kind is one run of it. Before a
 * call is sent its price (`provider-prices.ts`) is reserved; the
 * reservation is refused when it doesn't fit the caller's cap or the run's,
 * or when `PROVIDER_IN_FLIGHT` calls are already in flight. Prices are fixed
 * per call, so a settled call is charged its whole reservation, whatever
 * the response said or however it ended.
 *
 * Every reservation and settlement is one line appended to the ledger,
 * `<run>.host/provider/spend.jsonl`, and synced to disk before the call is
 * sent. On start the ledger is read back: a reservation with no settlement
 * counts in full. A ledger that can't be read, or holds a line that isn't
 * one of its own, refuses every billable call: the spend is then unknown.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { roundMeter, type MeterRefusal, type RunMeter } from '../model-meter.ts';
import { readRunFile } from './host-files.ts';

/** Who sent a call: a builder session, or the served copy of the app. */
export type CallerKind = 'session' | 'served';

export const CALLER_KINDS: readonly CallerKind[] = ['session', 'served'];

/** The most provider calls in flight at once, across every caller. */
export const PROVIDER_IN_FLIGHT = 3;

/** Why the ledger refused a reservation. */
export type LedgerRefusal = 'run-cap' | 'caller-cap' | 'in-flight' | 'ledger-unreadable';

/** How a call ended, as its settlement names it. */
export type CallOutcome = 'complete' | 'cut-off' | 'upstream-error' | 'refused-upstream';

export interface ReserveLine {
  type: 'reserve';
  id: string;
  time: string;
  caller: CallerKind;
  model: string;
  usd: number;
}

export interface SettleLine {
  type: 'settle';
  id: string;
  time: string;
  usd: number;
  outcome: CallOutcome;
}

export type LedgerLine = ReserveLine | SettleLine;

export interface LedgerReservation {
  readonly id: string;
  readonly reservedUsd: number;
  /** Ends the call, charging its whole reservation. Only the first call counts. */
  settle(outcome: CallOutcome): void;
}

export interface ProviderLedger {
  readonly capUsd: number;
  /** Why every billable call is refused, or undefined when the ledger is sound. */
  problem(): string | undefined;
  reserve(caller: CallerKind, model: string, usd: number): LedgerReservation | LedgerRefusal;
  spentUsd(): number;
  spentBy(caller: CallerKind): number;
  inFlight(): number;
}

export interface ProviderLedgerOptions {
  /** `<run>.host/provider/spend.jsonl`. */
  path: string;
  /** What sessions and the served copy may spend between them. */
  capUsd: number;
  /** What each caller kind may spend of `capUsd`; a kind not named may spend all of it. */
  callerCapsUsd?: Partial<Record<CallerKind, number>>;
  now?: () => Date;
}

const APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;

/** Appends one line and syncs it to disk, never through a link. */
function appendSynced(path: string, text: string): void {
  const fd = openSync(path, APPEND, 0o600);
  try {
    const bytes = Buffer.from(text);
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isCaller(value: unknown): value is CallerKind {
  return value === 'session' || value === 'served';
}

function isUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function lineOf(text: string): LedgerLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const line = parsed as Record<string, unknown>;
  const hasId = typeof line.id === 'string' && typeof line.time === 'string' && isUsd(line.usd);
  if (!hasId) return undefined;
  const isReserve = line.type === 'reserve' && isCaller(line.caller) && typeof line.model === 'string';
  const isSettle = line.type === 'settle' && typeof line.outcome === 'string';
  return isReserve || isSettle ? (parsed as LedgerLine) : undefined;
}

type Rebuilt = { ok: true; charged: Record<CallerKind, number> } | { ok: false; problem: string };

/** Each caller's charges so far: every reservation in full, or its settlement if that is higher. */
function rebuild(path: string): Rebuilt {
  const charged: Record<CallerKind, number> = { session: 0, served: 0 };
  const isAbsent = (() => {
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  })();
  if (isAbsent) return { ok: true, charged };
  const read = readRunFile(path);
  if (!read.ok) return { ok: false, problem: `the provider ledger can't be read: ${read.problem}` };
  const reserved = new Map<string, ReserveLine>();
  const settled = new Map<string, number>();
  const rows = read.text.split('\n').filter((row) => row.length > 0);
  for (const [index, row] of rows.entries()) {
    const line = lineOf(row);
    if (line === undefined) return { ok: false, problem: `the provider ledger's line ${index + 1} is not a ledger line` };
    if (line.type === 'reserve') reserved.set(line.id, line);
    else settled.set(line.id, line.usd);
  }
  for (const line of reserved.values()) charged[line.caller] += Math.max(line.usd, settled.get(line.id) ?? 0);
  return { ok: true, charged };
}

/** The meter's limit as the ledger names it: a caller kind is a run of the meter, and the run's cap is the meter's total. */
function refusalOf(refusal: MeterRefusal, hasSubCap: boolean): LedgerRefusal {
  if (refusal === 'run-cap') return hasSubCap ? 'caller-cap' : 'run-cap';
  if (refusal === 'round-cap') return 'run-cap';
  return 'in-flight';
}

/** Opens the ledger at `path`, counting what it already holds. */
export function openProviderLedger(options: ProviderLedgerOptions): ProviderLedger {
  const meter = roundMeter(options.capUsd);
  const capOf = (caller: CallerKind) => Math.min(options.callerCapsUsd?.[caller] ?? options.capUsd, options.capUsd);
  const runs = Object.fromEntries(CALLER_KINDS.map((caller) => [caller, meter.run(capOf(caller))])) as Record<CallerKind, RunMeter>;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const rebuilt = rebuild(options.path);
  let problem = rebuilt.ok ? undefined : rebuilt.problem;
  if (rebuilt.ok) {
    for (const caller of CALLER_KINDS) {
      const usd = rebuilt.charged[caller];
      if (usd === 0) continue;
      const carried = runs[caller].reserve(usd);
      if (typeof carried === 'string') problem = `the provider ledger's ${caller} spend is over its cap`;
      else carried.settle(usd);
    }
  }
  const inFlight = () => CALLER_KINDS.reduce((sum, caller) => sum + runs[caller].inFlight(), 0);
  const write = (line: LedgerLine): boolean => {
    try {
      appendSynced(options.path, `${JSON.stringify(line)}\n`);
      return true;
    } catch (error) {
      problem = `the provider ledger can't be written (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
      return false;
    }
  };
  return {
    capUsd: options.capUsd,
    problem: () => problem,
    spentUsd: () => meter.spentUsd(),
    spentBy: (caller) => runs[caller].spentUsd(),
    inFlight,
    reserve(caller, model, usd) {
      if (problem !== undefined) return 'ledger-unreadable';
      if (inFlight() >= PROVIDER_IN_FLIGHT) return 'in-flight';
      const reservation = runs[caller].reserve(usd);
      if (typeof reservation === 'string') return refusalOf(reservation, capOf(caller) < options.capUsd);
      const id = randomUUID();
      if (!write({ type: 'reserve', id, time: now(), caller, model, usd })) {
        // Unwritten, so never sent: the reservation still counts, and every later call is refused.
        reservation.settle(usd);
        return 'ledger-unreadable';
      }
      let isOpen = true;
      return {
        id,
        reservedUsd: usd,
        settle(outcome) {
          if (!isOpen) return;
          isOpen = false;
          reservation.settle(usd);
          write({ type: 'settle', id, time: now(), usd, outcome });
        },
      };
    },
  };
}
