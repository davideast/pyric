/**
 * Composable cartesian-product and bounded-concurrency combinators for
 * generative guard input grammars.
 */

export function cartesian2<A, B>(
  xs: readonly A[],
  ys: readonly B[],
): Array<readonly [A, B]> {
  const out: Array<readonly [A, B]> = [];
  for (const x of xs) {
    for (const y of ys) {
      out.push([x, y]);
    }
  }
  return out;
}

export function cartesian3<A, B, C>(
  xs: readonly A[],
  ys: readonly B[],
  zs: readonly C[],
): Array<readonly [A, B, C]> {
  const out: Array<readonly [A, B, C]> = [];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        out.push([x, y, z]);
      }
    }
  }
  return out;
}

export function cartesian4<A, B, C, D>(
  ws: readonly A[],
  xs: readonly B[],
  ys: readonly C[],
  zs: readonly D[],
): Array<readonly [A, B, C, D]> {
  const out: Array<readonly [A, B, C, D]> = [];
  for (const w of ws) {
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          out.push([w, x, y, z]);
        }
      }
    }
  }
  return out;
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      const item = items[idx];
      if (item !== undefined) {
        out[idx] = await fn(item);
      }
    }
  }
  const workers: Array<Promise<void>> = [];
  const count = Math.min(concurrency, items.length);
  for (let i = 0; i < count; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}
