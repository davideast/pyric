/**
 *Deterministic PRNG (mulberry32) used to synthesize reproducible Firestore
 * operation sequences from a single 32-bit integer seed.
 */

export interface Prng {
  next(): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T;
  shuffle<T>(items: readonly T[]): T[];
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  function int(min: number, max: number): number {
    return min + Math.floor(next() * (max - min + 1));
  }

  function chance(probability: number): boolean {
    return next() < probability;
  }

  function pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty array.');
    }
    const index = Math.floor(next() * items.length);
    const chosen = items[index];
    if (chosen === undefined) {
      return items[0] as T;
    }
    return chosen;
  }

  function weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    if (entries.length === 0) {
      throw new Error('Cannot pick from an empty weighted table.');
    }
    let total = 0;
    for (const [weight] of entries) {
      total += weight;
    }
    let roll = next() * total;
    for (const [weight, item] of entries) {
      roll -= weight;
      if (roll <= 0) {
        return item;
      }
    }
    const fallback = entries[entries.length - 1];
    if (fallback === undefined) {
      throw new Error('Weighted table fallback missing.');
    }
    return fallback[1];
  }

  function shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      const left = copy[i] as T;
      const right = copy[j] as T;
      copy[i] = right;
      copy[j] = left;
    }
    return copy;
  }

  return { next, int, chance, pick, weighted, shuffle };
}
