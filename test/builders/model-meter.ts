/**
 * The round's spend, as the model forwarder meters it from the responses it
 * passes back. Every run of a round shares one round meter, and each run has
 * its own share of it. Before the forwarder sends a request on, it asks the
 * run's meter: once the run has spent its cap (`--max-budget-usd`), or the
 * round its total (`--max-round-usd`), the request is refused.
 *
 * The check happens per request, so a request already on its way can carry a
 * run past its cap by its own cost, and the next one is refused. claude's own
 * `--max-budget-usd` runs too; the meter is the one the builder can't change.
 */

export type CapReached = 'run-cap' | 'round-cap';

export interface RequestCharge {
  /** Sets what this request has cost so far. A streamed response raises it as it arrives. */
  set(usd: number): void;
}

export interface RunMeter {
  readonly capUsd: number;
  /** Which cap stops the next request, if one does. */
  capReached(): CapReached | undefined;
  /** A charge for one request, at $0 until it is set. */
  charge(): RequestCharge;
  spentUsd(): number;
}

export interface RoundMeter {
  readonly maxRoundUsd: number;
  run(capUsd: number): RunMeter;
  spentUsd(): number;
}

const total = (charges: ReadonlyMap<object, number>) => [...charges.values()].reduce((sum, usd) => sum + usd, 0);

export function roundMeter(maxRoundUsd: number): RoundMeter {
  const runs: Array<() => number> = [];
  const roundSpent = () => runs.reduce((sum, spent) => sum + spent(), 0);
  return {
    maxRoundUsd,
    spentUsd: roundSpent,
    run(capUsd) {
      const charges = new Map<object, number>();
      const spentUsd = () => total(charges);
      runs.push(spentUsd);
      return {
        capUsd,
        spentUsd,
        capReached() {
          if (spentUsd() >= capUsd) return 'run-cap';
          if (roundSpent() >= maxRoundUsd) return 'round-cap';
          return undefined;
        },
        charge() {
          const key = {};
          charges.set(key, 0);
          return { set: (usd) => charges.set(key, Math.max(charges.get(key) ?? 0, usd)) };
        },
      };
    },
  };
}
