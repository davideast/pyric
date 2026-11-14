/**
 * Joint per-field Firestore query-constraint witness synthesis across equality,
 * `in`, `not-in`, `!=`, open/closed range bounds (`<`, `<=`, `>`, `>=`), and
 * array membership (`array-contains`, `array-contains-any`) for all Firestore
 * scalar types.
 */
import {
  Bytes,
  Duration,
  LatLng,
  Path,
  Reference,
  Timestamp,
  type QueryWhereConstraint,
} from '@pyric/rules/internal';
import {
  clauseMatchesCandidate,
  compareOrderedScalars,
  fromTotalNanosDuration,
  fromTotalNanosTimestamp,
  scalarKindOf,
  totalNanos,
  unwrapScalar,
  valuesEqual,
  type ScalarKind,
} from './static-query-proof-scalar-order.js';

interface RangeBound {
  readonly val: unknown;
  readonly inclusive: boolean;
}

function safeInteriorCodePoint(code: number): string {
  if (code === 47) return '0';
  return String.fromCodePoint(code);
}

function stringMidpoints(lo: string, hi: string): string[] {
  const loPts = [...lo];
  const hiPts = [...hi];
  let idx = 0;
  while (idx < loPts.length && idx < hiPts.length && loPts[idx] === hiPts[idx]) {
    idx += 1;
  }
  const out: string[] = [];
  if (idx === loPts.length) {
    let pos = idx;
    while (pos < hiPts.length && hiPts[pos]!.codePointAt(0)! === 0) {
      pos += 1;
    }
    if (pos >= hiPts.length) return [];
    const hiCode = hiPts[pos]!.codePointAt(0)!;
    const prefix = hiPts.slice(0, pos).join('');
    if (hiCode > 97) out.push(`${prefix}a`, `${prefix}0`);
    else if (hiCode > 48) out.push(`${prefix}0`);
    if (hiCode > 1) {
      for (let k = 1; k < Math.min(hiCode, 16); k += 1) {
        const candidateCode = Math.max(1, Math.floor((hiCode * k) / 16));
        out.push(`${prefix}${safeInteriorCodePoint(candidateCode)}`);
      }
      return out;
    }
    for (let k = 0; k < 12; k += 1) {
      out.push(`${prefix}\u0000${String.fromCharCode(97 + k)}`);
    }
    return out;
  }
  const cLo = loPts[idx]!.codePointAt(0)!;
  const cHi = hiPts[idx]!.codePointAt(0)!;
  const shared = loPts.slice(0, idx).join('');
  if (cHi - cLo > 1) {
    for (let k = 1; k < Math.min(cHi - cLo, 16); k += 1) {
      const code = cLo + k;
      if (code !== 47) out.push(`${shared}${String.fromCodePoint(code)}`);
    }
    const mid = Math.floor((cLo + cHi) / 2);
    if (mid !== 47) out.push(`${shared}${String.fromCodePoint(mid)}`);
  }
  for (let k = 0; k < 12; k += 1) {
    out.push(`${lo}${String.fromCharCode(97 + k)}`);
  }
  return out;
}

function bytesMidpoints(lo: Uint8Array, hi: Uint8Array): Bytes[] {
  let idx = 0;
  while (idx < lo.length && idx < hi.length && lo[idx] === hi[idx]) {
    idx += 1;
  }
  const out: Bytes[] = [];
  if (idx === lo.length) {
    let pos = idx;
    while (pos < hi.length && hi[pos] === 0) {
      pos += 1;
    }
    if (pos >= hi.length) return [];
    const hiByte = hi[pos]!;
    const prefix = hi.slice(0, pos);
    if (hiByte > 1) {
      for (let k = 1; k < Math.min(hiByte, 16); k += 1) {
        out.push(new Bytes(new Uint8Array([...prefix, k])));
      }
      out.push(new Bytes(new Uint8Array([...prefix, Math.floor(hiByte / 2)])));
      return out;
    }
    for (let k = 1; k <= 16; k += 1) {
      out.push(new Bytes(new Uint8Array([...prefix, 0, k * 8])));
    }
    return out;
  }
  const bLo = lo[idx]!;
  const bHi = hi[idx]!;
  if (bHi - bLo > 1) {
    const shared = lo.slice(0, idx);
    out.push(new Bytes(new Uint8Array([...shared, Math.floor((bLo + bHi) / 2)])));
    for (let k = 1; k < Math.min(bHi - bLo, 16); k += 1) {
      out.push(new Bytes(new Uint8Array([...shared, bLo + k])));
    }
  }
  for (let k = 1; k <= 16; k += 1) {
    out.push(new Bytes(new Uint8Array([...lo, k * 8])));
  }
  return out;
}

function buildOrderedCandidates(
  kind: ScalarKind,
  lower: RangeBound | undefined,
  upper: RangeBound | undefined,
  excluded: readonly unknown[],
): unknown[] {
  const candidates: unknown[] = [];
  if (lower?.inclusive) candidates.push(unwrapScalar(lower.val));
  if (upper?.inclusive) candidates.push(unwrapScalar(upper.val));

  switch (kind) {
    case 'number': {
      let lo: number | undefined;
      if (lower !== undefined) lo = unwrapScalar(lower.val) as number;
      let hi: number | undefined;
      if (upper !== undefined) hi = unwrapScalar(upper.val) as number;
      if (lo !== undefined && hi !== undefined) {
        let firstInt = Math.ceil(lo);
        if (!lower!.inclusive && firstInt === lo) firstInt += 1;
        for (let k = 0; k < 16; k += 1) {
          const candInt = firstInt + k;
          if (candInt <= hi) candidates.push(candInt);
        }
        for (let k = 1; k <= 16; k += 1) {
          candidates.push(lo + ((hi - lo) * k) / 17);
        }
        candidates.push((lo + hi) / 2);
      } else if (lo !== undefined) {
        const baseInt = Math.floor(lo) + 1;
        for (let k = 0; k < 16; k += 1) candidates.push(baseInt + k);
        candidates.push(lo + 0.5, lo + 1);
      } else if (hi !== undefined) {
        const baseInt = Math.ceil(hi) - 1;
        for (let k = 0; k < 16; k += 1) candidates.push(baseInt - k);
        candidates.push(hi - 0.5, hi - 1);
      } else {
        for (let k = 1; k <= 16; k += 1) candidates.push(k);
      }
      break;
    }
    case 'string': {
      let lo: string | undefined;
      if (lower !== undefined) lo = lower.val as string;
      let hi: string | undefined;
      if (upper !== undefined) hi = upper.val as string;
      if (lo !== undefined && hi !== undefined) {
        for (const mid of stringMidpoints(lo, hi)) {
          candidates.push(mid, `${mid}1`, `${mid}2`);
        }
      } else if (lo !== undefined) {
        for (let k = 0; k < 16; k += 1) {
          candidates.push(`${lo}${String.fromCharCode(97 + k)}`);
        }
      } else if (hi !== undefined) {
        if (hi.length > 0) {
          for (const mid of stringMidpoints('', hi)) candidates.push(mid);
          if (hi.length > 1) candidates.push(hi.slice(0, -1));
          candidates.push('');
        }
      } else {
        for (let k = 0; k < 16; k += 1) candidates.push(`witness_${k}`);
        for (const ex of excluded) {
          if (typeof ex === 'string' && !ex.includes('/')) candidates.push(`${ex}_alt`);
        }
      }
      break;
    }
    case 'timestamp':
    case 'duration': {
      let build: (nanos: bigint) => Timestamp | Duration = fromTotalNanosDuration;
      if (kind === 'timestamp') build = fromTotalNanosTimestamp;
      let lo: bigint | undefined;
      if (lower !== undefined) lo = totalNanos(lower.val as Timestamp | Duration);
      let hi: bigint | undefined;
      if (upper !== undefined) hi = totalNanos(upper.val as Timestamp | Duration);
      if (lo !== undefined && hi !== undefined) {
        const mid = (lo + hi) / 2n;
        candidates.push(build(mid));
        for (let k = 1n; k <= 16n; k += 1n) {
          const step = ((hi - lo) * k) / 17n;
          if (step > 0n) candidates.push(build(lo + step));
        }
      } else if (lo !== undefined) {
        for (let k = 1n; k <= 16n; k += 1n) {
          candidates.push(build(lo + k * 1_000_000_000n), build(lo + k));
        }
      } else if (hi !== undefined) {
        for (let k = 1n; k <= 16n; k += 1n) {
          candidates.push(build(hi - k * 1_000_000_000n), build(hi - k));
        }
      } else {
        let base = 60_000_000_000n;
        if (kind === 'timestamp') base = 1_700_000_000_000_000_000n;
        for (let k = 1n; k <= 16n; k += 1n) {
          candidates.push(build(base + k * 1_000_000_000n));
        }
      }
      break;
    }
    case 'bytes': {
      let lo: Uint8Array | undefined;
      if (lower !== undefined) lo = (lower.val as Bytes).data;
      let hi: Uint8Array | undefined;
      if (upper !== undefined) hi = (upper.val as Bytes).data;
      if (lo !== undefined && hi !== undefined) {
        candidates.push(...bytesMidpoints(lo, hi));
      } else if (lo !== undefined) {
        for (let k = 1; k <= 16; k += 1) candidates.push(new Bytes(new Uint8Array([...lo, k])));
      } else if (hi !== undefined) {
        if (hi.length > 0) {
          candidates.push(...bytesMidpoints(new Uint8Array([]), hi));
          if (hi.length > 1) candidates.push(new Bytes(hi.slice(0, -1)));
          candidates.push(new Bytes(new Uint8Array([])));
        }
      } else {
        for (let k = 1; k <= 16; k += 1) candidates.push(new Bytes(new Uint8Array([k])));
      }
      break;
    }
    case 'boolean':
      candidates.push(false, true);
      break;
    case 'latlng': {
      let lo: LatLng | undefined;
      if (lower !== undefined) lo = lower.val as LatLng;
      let hi: LatLng | undefined;
      if (upper !== undefined) hi = upper.val as LatLng;
      if (lo && hi) {
        candidates.push(new LatLng((lo.lat + hi.lat) / 2, (lo.lng + hi.lng) / 2));
        for (let k = 1; k <= 16; k += 1) {
          const lat = lo.lat + ((hi.lat - lo.lat) * k) / 17;
          const lng = lo.lng + ((hi.lng - lo.lng) * k) / 17;
          candidates.push(new LatLng(lat, lng));
        }
      } else if (lo) {
        for (let k = 1; k <= 16; k += 1) {
          if (lo.lat < 90) candidates.push(new LatLng(lo.lat + ((90 - lo.lat) * k) / 17, lo.lng));
          if (lo.lng < 180) candidates.push(new LatLng(lo.lat, lo.lng + ((180 - lo.lng) * k) / 17));
        }
      } else if (hi) {
        for (let k = 1; k <= 16; k += 1) {
          if (hi.lat > -90) candidates.push(new LatLng(hi.lat - ((hi.lat + 90) * k) / 17, hi.lng));
          if (hi.lng > -180) candidates.push(new LatLng(hi.lat, hi.lng - ((hi.lng + 180) * k) / 17));
        }
      } else {
        for (let k = 0; k < 16; k += 1) candidates.push(new LatLng(k, k));
      }
      break;
    }
    case 'reference': {
      const sample = (lower?.val ?? upper?.val ?? excluded.find((e) => e instanceof Reference)) as Reference | undefined;
      const dbId = sample?.databaseId ?? '(default)';
      let loPath: string | undefined;
      if (lower !== undefined) loPath = (lower.val as Reference).path;
      let hiPath: string | undefined;
      if (upper !== undefined) hiPath = (upper.val as Reference).path;
      if (loPath !== undefined && hiPath !== undefined) {
        for (const mid of stringMidpoints(loPath, hiPath)) {
          if (mid.split('/').length % 2 === 0) candidates.push(new Reference(mid, dbId));
        }
      } else if (loPath !== undefined) {
        for (let k = 1; k <= 12; k += 1) {
          candidates.push(new Reference(`${loPath}_${k}`, dbId));
        }
      } else if (hiPath !== undefined && hiPath.length > 0) {
        for (const mid of stringMidpoints('a/a', hiPath)) {
          if (mid.split('/').length % 2 === 0) candidates.push(new Reference(mid, dbId));
        }
      } else {
        for (let k = 1; k <= 16; k += 1) candidates.push(new Reference(`col/doc_${k}`, dbId));
      }
      break;
    }
    case 'path': {
      let loSegs: readonly string[] | undefined;
      if (lower !== undefined) loSegs = (lower.val as Path).segments;
      let hiSegs: readonly string[] | undefined;
      if (upper !== undefined) hiSegs = (upper.val as Path).segments;
      if (loSegs) {
        for (let k = 1; k <= 12; k += 1) {
          candidates.push(new Path([...loSegs.slice(0, -1), `${loSegs.at(-1) ?? 'doc'}_${k}`]));
        }
      }
      if (hiSegs && hiSegs.length > 0) {
        const last = hiSegs.at(-1) ?? '';
        if (last.length > 1) candidates.push(new Path([...hiSegs.slice(0, -1), last.slice(0, -1)]));
      }
      for (let k = 1; k <= 16; k += 1) candidates.push(new Path(['col', `doc_${k}`]));
      break;
    }
    case 'null':
      candidates.push('non-null');
      break;
  }
  return candidates;
}

/**
 * Synthesize a single concrete field value satisfying all `clauses` on one
 * field, or `undefined` if the clauses are jointly unsatisfiable.
 */
export function synthesizeFieldWitness(clauses: readonly QueryWhereConstraint[]): unknown {
  if (clauses.length === 0) return undefined;

  const eqOrIn = clauses.find((c) => c.op === '==' || c.op === 'in');
  if (eqOrIn !== undefined) {
    let domain: readonly unknown[];
    if (eqOrIn.op === '==') {
      domain = [eqOrIn.value];
    } else if (Array.isArray(eqOrIn.value)) {
      domain = eqOrIn.value;
    } else {
      return undefined;
    }
    for (const cand of domain) {
      if (clauses.every((c) => clauseMatchesCandidate(cand, c))) {
        return unwrapScalar(cand);
      }
    }
    return undefined;
  }

  const hasArrayOp = clauses.some(
    (c) => c.op === 'array-contains' || c.op === 'array-contains-any',
  );
  if (hasArrayOp) {
    const items: unknown[] = [];
    const pushItem = (v: unknown): void => {
      if (!items.some((existing) => valuesEqual(existing, v))) {
        items.push(v);
      }
    };
    for (const c of clauses) {
      if (c.op === 'array-contains') {
        pushItem(c.value);
      } else if (c.op === 'array-contains-any') {
        if (!Array.isArray(c.value) || c.value.length === 0) return undefined;
        pushItem(c.value[0]);
      }
    }
    for (const candidateArr of [items, [...items, '__extra_0__'], [...items, '__extra_1__']]) {
      if (clauses.every((c) => clauseMatchesCandidate(candidateArr, c))) {
        return candidateArr;
      }
    }
    return undefined;
  }

  let lower: RangeBound | undefined;
  let upper: RangeBound | undefined;
  const excluded: unknown[] = [];
  let inferredKind: ScalarKind | null = null;

  for (const c of clauses) {
    if (c.op === 'not-in') {
      if (!Array.isArray(c.value)) return undefined;
      if (c.value.some((item) => item === null)) return undefined;
      for (const item of c.value) {
        excluded.push(item);
        const itemKind = scalarKindOf(item);
        if (inferredKind === null && itemKind !== null && itemKind !== 'null') {
          inferredKind = itemKind;
        }
      }
      continue;
    }
    if (c.op === '!=') {
      excluded.push(c.value);
      const itemKind = scalarKindOf(c.value);
      if (inferredKind === null && itemKind !== null && itemKind !== 'null') {
        inferredKind = itemKind;
      }
      continue;
    }
    if (c.op === '>' || c.op === '>=') {
      const boundKind = scalarKindOf(c.value);
      if (boundKind === null || boundKind === 'null') return undefined;
      if (inferredKind !== null && inferredKind !== boundKind) return undefined;
      inferredKind = boundKind;
      const inclusive = c.op === '>=';
      if (lower === undefined) {
        lower = { val: c.value, inclusive };
      } else {
        const cmp = compareOrderedScalars(c.value, lower.val);
        if (cmp === null) return undefined;
        if (cmp > 0 || (cmp === 0 && !inclusive)) {
          lower = { val: c.value, inclusive };
        }
      }
      continue;
    }
    if (c.op === '<' || c.op === '<=') {
      const boundKind = scalarKindOf(c.value);
      if (boundKind === null || boundKind === 'null') return undefined;
      if (inferredKind !== null && inferredKind !== boundKind) return undefined;
      inferredKind = boundKind;
      const inclusive = c.op === '<=';
      if (upper === undefined) {
        upper = { val: c.value, inclusive };
      } else {
        const cmp = compareOrderedScalars(c.value, upper.val);
        if (cmp === null) return undefined;
        if (cmp < 0 || (cmp === 0 && !inclusive)) {
          upper = { val: c.value, inclusive };
        }
      }
      continue;
    }
    return undefined;
  }

  if (lower !== undefined && upper !== undefined) {
    const cmp = compareOrderedScalars(lower.val, upper.val);
    if (cmp === null || cmp > 0 || (cmp === 0 && (!lower.inclusive || !upper.inclusive))) {
      return undefined;
    }
  }

  const targetKind: ScalarKind = inferredKind ?? 'string';
  const candidates = buildOrderedCandidates(targetKind, lower, upper, excluded);
  for (const cand of candidates) {
    if (
      !excluded.some((ex) => valuesEqual(cand, ex))
      && clauses.every((c) => clauseMatchesCandidate(cand, c))
    ) {
      return cand;
    }
  }
  return undefined;
}
