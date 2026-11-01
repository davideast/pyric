/**
 * The round's spend, as the model forwarder meters it. Every run of a round
 * shares one round meter, and each run has its own share of it.
 *
 * Before the forwarder sends a request on, it reserves the request's worst
 * case (`model-prices.ts`). The reservation is refused when it doesn't fit
 * what is left of the run's cap (`--max-budget-usd`) or the round's total
 * (`--max-round-usd`), so requests sent at once can't pass either between
 * them: each one's worst case counts until it is settled. When the response
 * ends, the reservation settles to what the response cost; a response cut
 * off keeps its whole reservation. A run has at most two requests in flight.
 *
 * claude's own `--max-budget-usd` runs too; the meter is the one the builder
 * can't change.
 */

export type MeterRefusal = 'run-cap' | 'round-cap' | 'in-flight';

export const MAX_IN_FLIGHT = 2;

export interface Reservation {
  readonly reservedUsd: number;
  /** Ends the request, charging `usd` in place of the reservation. Only the first call counts. */
  settle(usd: number): void;
  /** What this request is charged: its reservation until it settles. */
  chargedUsd(): number;
}

export interface RunMeter {
  readonly capUsd: number;
  /** Reserves `usd` for one request, or says which limit refuses it. */
  reserve(usd: number): Reservation | MeterRefusal;
  /** Settled charges plus every open reservation. */
  spentUsd(): number;
  inFlight(): number;
}

export interface RoundMeter {
  readonly maxRoundUsd: number;
  run(capUsd: number): RunMeter;
  spentUsd(): number;
}

/** Room for rounding, so a reservation that exactly fills a cap fits. */
const EPSILON_USD = 1e-9;

interface Entry {
  usd: number;
  open: boolean;
}

export function roundMeter(maxRoundUsd: number): RoundMeter {
  const runs: RunMeter[] = [];
  const roundSpent = () => runs.reduce((sum, run) => sum + run.spentUsd(), 0);
  return {
    maxRoundUsd,
    spentUsd: roundSpent,
    run(capUsd) {
      const entries: Entry[] = [];
      const spentUsd = () => entries.reduce((sum, entry) => sum + entry.usd, 0);
      const inFlight = () => entries.filter((entry) => entry.open).length;
      const refusalOf = (usd: number): MeterRefusal | undefined => {
        if (inFlight() >= MAX_IN_FLIGHT) return 'in-flight';
        if (spentUsd() + usd > capUsd + EPSILON_USD) return 'run-cap';
        if (roundSpent() + usd > maxRoundUsd + EPSILON_USD) return 'round-cap';
        return undefined;
      };
      const run: RunMeter = {
        capUsd,
        spentUsd,
        inFlight,
        reserve(usd) {
          const refusal = refusalOf(usd);
          if (refusal !== undefined) return refusal;
          const entry: Entry = { usd, open: true };
          entries.push(entry);
          return {
            reservedUsd: usd,
            chargedUsd: () => entry.usd,
            settle(charged) {
              if (!entry.open) return;
              entry.open = false;
              entry.usd = charged;
            },
          };
        },
      };
      runs.push(run);
      return run;
    },
  };
}
