// Deterministic seeded PRNG for property-based differential fuzzing.
// Uses SplitMix32 for simple, fast, cross-runtime reproducible streams.

export interface SeededRng {
  readonly seed: number;
  nextUint32(): number;
  nextFloat(): number;
  bool(probability?: number): boolean;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [number, T])[]): T;
  fork(salt: number): SeededRng;
}

export function createRng(seed: number): SeededRng {
  const initial = seed >>> 0;
  let state = initial;

  function nextUint32(): number {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  }

  function nextFloat(): number {
    return nextUint32() / 0x100000000;
  }

  function bool(probability = 0.5): boolean {
    return nextFloat() < probability;
  }

  function int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError('Invalid integer range: ' + min + '..' + max);
    }
    const span = max - min + 1;
    return min + (nextUint32() % span);
  }

  function pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Cannot pick from empty array');
    return items[nextUint32() % items.length]!;
  }

  function weighted<T>(entries: readonly (readonly [number, T])[]): T {
    let total = 0;
    for (const [w] of entries) {
      if (w > 0) total += w;
    }
    if (total <= 0) throw new RangeError('Weighted entries must have positive total weight');
    let target = nextFloat() * total;
    for (const [w, value] of entries) {
      if (w <= 0) continue;
      target -= w;
      if (target <= 0) return value;
    }
    return entries[entries.length - 1]![1];
  }

  function fork(salt: number): SeededRng {
    return createRng((nextUint32() ^ Math.imul(salt >>> 0, 0x9e3779b1)) >>> 0);
  }

  return { seed: initial, nextUint32, nextFloat, bool, int, pick, weighted, fork };
}
