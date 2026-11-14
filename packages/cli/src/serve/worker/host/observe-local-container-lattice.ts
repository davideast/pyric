/**
 * Shared abstract container-lattice operations (`union`, `slice`, `concat`, and
 * `ternary` list-shape preservation) for Firestore trace canonicalization
 * (`observe-local-firestore-trace.ts`) and Storage AST missing-property
 * analysis (`observe-local-storage-ast.ts`).
 */

interface ListShape<T> {
  readonly items: readonly T[];
  readonly dynamicElement?: T;
}

export interface LatticeAdapter<T extends { readonly kind: string }> {
  readonly none: T;
  isUnion(value: T): readonly T[] | undefined;
  isList(value: T): ListShape<T> | undefined;
  makeUnion(options: readonly T[]): T;
  makeList(items: readonly T[], dynamicElement?: T): T;
}

export function flattenOptions<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  value: T,
): readonly T[] {
  if (value.kind === 'none') return [];
  const unionOpts = adapter.isUnion(value);
  if (unionOpts !== undefined) return unionOpts;
  return [value];
}

export function unionValues<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  values: readonly T[],
): T {
  const flat: T[] = [];
  for (const val of values) {
    flat.push(...flattenOptions(adapter, val));
  }
  if (flat.length === 0) return adapter.none;
  if (flat.length === 1) return flat[0]!;
  return adapter.makeUnion(flat);
}

export function hasListOption<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  value: T,
): boolean {
  return flattenOptions(adapter, value).some((opt) => adapter.isList(opt) !== undefined);
}

export function allListElements<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  value: T,
): T {
  const parts: T[] = [];
  for (const opt of flattenOptions(adapter, value)) {
    const list = adapter.isList(opt);
    if (list !== undefined) {
      parts.push(...list.items);
      if (list.dynamicElement !== undefined) parts.push(list.dynamicElement);
    }
  }
  return unionValues(adapter, parts);
}

export function sliceListValue<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  value: T,
  startIdx: number | undefined,
  endIdx: number | undefined,
  preserveNonList: boolean,
): T {
  const results: T[] = [];
  for (const opt of flattenOptions(adapter, value)) {
    const list = adapter.isList(opt);
    if (list === undefined) {
      if (preserveNonList) results.push(opt);
      continue;
    }
    if (startIdx !== undefined && endIdx !== undefined) {
      results.push(adapter.makeList(list.items.slice(startIdx, endIdx), list.dynamicElement));
    } else if (startIdx !== undefined && !preserveNonList) {
      results.push(adapter.makeList(list.items.slice(startIdx), list.dynamicElement));
    } else {
      const pool = [...list.items];
      if (list.dynamicElement !== undefined) pool.push(list.dynamicElement);
      results.push(adapter.makeList([], unionValues(adapter, pool)));
    }
  }
  return unionValues(adapter, results);
}

export function concatListValues<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  leftVal: T,
  rightVal: T,
  includeNonListRightArg: boolean,
): T {
  const leftOpts = flattenOptions(adapter, leftVal);
  const rightOpts = flattenOptions(adapter, rightVal);
  const leftLists: ListShape<T>[] = [];
  const rightLists: ListShape<T>[] = [];
  const elemPool: T[] = [];
  let hasOpaqueLeft = leftOpts.length === 0;
  let hasOpaqueRight = rightOpts.length === 0;

  for (const opt of leftOpts) {
    const list = adapter.isList(opt);
    if (list !== undefined) {
      leftLists.push(list);
      elemPool.push(...list.items);
      if (list.dynamicElement !== undefined) elemPool.push(list.dynamicElement);
    } else {
      hasOpaqueLeft = true;
    }
  }
  for (const opt of rightOpts) {
    const list = adapter.isList(opt);
    if (list !== undefined) {
      rightLists.push(list);
      elemPool.push(...list.items);
      if (list.dynamicElement !== undefined) elemPool.push(list.dynamicElement);
    } else {
      hasOpaqueRight = true;
      if (includeNonListRightArg) elemPool.push(opt);
    }
  }

  const results: T[] = [];
  for (const l of leftLists) {
    for (const r of rightLists) {
      if (l.dynamicElement === undefined) {
        results.push(adapter.makeList([...l.items, ...r.items], r.dynamicElement));
      } else {
        const pairPool = [...l.items, l.dynamicElement, ...r.items];
        if (r.dynamicElement !== undefined) pairPool.push(r.dynamicElement);
        results.push(adapter.makeList([], unionValues(adapter, pairPool)));
      }
    }
  }
  if (hasOpaqueLeft || hasOpaqueRight) {
    const merged = unionValues(adapter, elemPool);
    if (merged.kind !== 'none') {
      results.push(adapter.makeList([], merged));
    }
  }
  return unionValues(adapter, results);
}

export function ternaryValues<T extends { readonly kind: string }>(
  adapter: LatticeAdapter<T>,
  branches: readonly T[],
): T {
  const hasListBranch = branches.some((b) => hasListOption(adapter, b));
  const hasOpaqueBranch = branches.some((b) => {
    const opts = flattenOptions(adapter, b);
    return opts.length === 0 || opts.some((o) => adapter.isList(o) === undefined);
  });
  if (hasListBranch && hasOpaqueBranch) {
    return unionValues(adapter, [...branches, adapter.makeList([])]);
  }
  return unionValues(adapter, branches);
}
