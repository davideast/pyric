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
  queryProofScalarsEqual,
  Reference,
  RulesFloat,
  Timestamp,
  type QueryWhereConstraint,
} from '@pyric/rules/internal';

type ScalarKind =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'timestamp'
  | 'duration'
  | 'bytes'
  | 'latlng'
  | 'reference'
  | 'path';

interface RangeBound {
  readonly val: unknown;
  readonly inclusive: boolean;
}

function unwrapScalar(value: unknown): unknown {
  if (value instanceof RulesFloat) return value.value;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function scalarKindOf(raw: unknown): ScalarKind | null {
  const value = unwrapScalar(raw);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string') return 'string';
  if (value instanceof Timestamp) return 'timestamp';
  if (value instanceof Duration) return 'duration';
  if (value instanceof Bytes) return 'bytes';
  if (value instanceof LatLng) return 'latlng';
  if (value instanceof Reference) return 'reference';
  if (value instanceof Path) return 'path';
  return null;
}

function compareStringsByCodePoint(a: string, b: string): number {
  const aPoints = [...a];
  const bPoints = [...b];
  const minLen = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < minLen; i += 1) {
    const cpA = aPoints[i]!.codePointAt(0)!;
    const cpB = bPoints[i]!.codePointAt(0)!;
    if (cpA !== cpB) return cpA - cpB;
  }
  return aPoints.length - bPoints.length;
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    const cmp = compareStringsByCodePoint(a[i]!, b[i]!);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

function totalNanos(val: Timestamp | Duration): bigint {
  return BigInt(val.seconds) * 1_000_000_000n + BigInt(val.nanos);
}

function fromTotalNanosTimestamp(ns: bigint): Timestamp {
  let seconds = ns / 1_000_000_000n;
  let nanos = ns % 1_000_000_000n;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += 1_000_000_000n;
  }
  return new Timestamp(Number(seconds), Number(nanos));
}

function fromTotalNanosDuration(ns: bigint): Duration {
  const seconds = ns / 1_000_000_000n;
  const nanos = ns % 1_000_000_000n;
  return new Duration(Number(seconds), Number(nanos));
}

function compareOrderedScalars(rawA: unknown, rawB: unknown): number | null {
  const kindA = scalarKindOf(rawA);
  const kindB = scalarKindOf(rawB);
  if (kindA === null || kindB === null || kindA !== kindB || kindA === 'null') {
    return null;
  }
  const a = unwrapScalar(rawA);
  const b = unwrapScalar(rawB);
  switch (kindA) {
    case 'boolean':
      return Number(a as boolean) - Number(b as boolean);
    case 'number': {
      const numA = a as number;
      const numB = b as number;
      if (numA === numB) return 0;
      if (numA < numB) return -1;
      return 1;
    }
    case 'string':
      return compareStringsByCodePoint(a as string, b as string);
    case 'timestamp':
    case 'duration': {
      const nsA = totalNanos(a as Timestamp | Duration);
      const nsB = totalNanos(b as Timestamp | Duration);
      if (nsA === nsB) return 0;
      if (nsA < nsB) return -1;
      return 1;
    }
    case 'bytes': {
      const ba = (a as Bytes).data;
      const bb = (b as Bytes).data;
      const minLen = Math.min(ba.length, bb.length);
      for (let i = 0; i < minLen; i += 1) {
        if (ba[i]! !== bb[i]!) return ba[i]! - bb[i]!;
      }
      return ba.length - bb.length;
    }
    case 'latlng': {
      const la = a as LatLng;
      const lb = b as LatLng;
      if (la.lat !== lb.lat) return la.lat - lb.lat;
      return la.lng - lb.lng;
    }
    case 'reference': {
      const ra = a as Reference;
      const rb = b as Reference;
      const dbCmp = compareStringsByCodePoint(ra.databaseId, rb.databaseId);
      if (dbCmp !== 0) return dbCmp;
      return compareStringArrays(ra.path.split('/'), rb.path.split('/'));
    }
    case 'path':
      return compareStringArrays((a as Path).segments, (b as Path).segments);
  }
}

function scalarsCompareEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === null && b === null;
  const cmp = compareOrderedScalars(a, b);
  return cmp === 0;
}

function clauseMatchesCandidate(
  candidate: unknown,
  clause: QueryWhereConstraint,
): boolean {
  if (candidate === undefined) return false;
  switch (clause.op) {
    case '==':
      return scalarsCompareEqual(candidate, clause.value);
    case '!=':
      return candidate !== null && !scalarsCompareEqual(candidate, clause.value);
    case '<': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp < 0;
    }
    case '<=': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp <= 0;
    }
    case '>': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp > 0;
    }
    case '>=': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp >= 0;
    }
    case 'in':
      return (
        Array.isArray(clause.value)
        && clause.value.some((item) => scalarsCompareEqual(candidate, item))
      );
    case 'not-in':
      if (!Array.isArray(clause.value)) return false;
      if (clause.value.some((item) => item === null)) return false;
      return (
        candidate !== null
        && !clause.value.some((item) => scalarsCompareEqual(candidate, item))
      );
    case 'array-contains':
      return (
        Array.isArray(candidate)
        && candidate.some((item) => scalarsCompareEqual(item, clause.value))
      );
    case 'array-contains-any':
      return (
        Array.isArray(candidate)
        && Array.isArray(clause.value)
        && clause.value.some((target) =>
          candidate.some((item) => scalarsCompareEqual(item, target)),
        )
      );
    default:
      return false;
  }
}

function stringMidpoints(lo: string, hi: string): string[] {
  const loPts = [...lo];
  const hiPts = [...hi];
  let idx = 0;
  while (idx < loPts.length && idx < hiPts.length && loPts[idx] === hiPts[idx]) {
    idx += 1;
  }
  if (idx === loPts.length) {
    let pos = idx;
    while (pos < hiPts.length && hiPts[pos]!.codePointAt(0)! === 0) {
      pos += 1;
    }
    if (pos >= hiPts.length) return [];
    const hiCode = hiPts[pos]!.codePointAt(0)!;
    const prefix = hiPts.slice(0, pos).join('');
    if (hiCode > 97) return [`${prefix}a`, `${prefix}0`, `${prefix}${String.fromCodePoint(Math.floor(hiCode / 2))}`];
    if (hiCode > 48) return [`${prefix}0`, `${prefix}${String.fromCodePoint(Math.floor(hiCode / 2))}`];
    if (hiCode > 1) return [`${prefix}${String.fromCodePoint(Math.floor(hiCode / 2))}`];
    return [`${prefix}\u0000a`, `${prefix}\u0000m`];
  }
  const cLo = loPts[idx]!.codePointAt(0)!;
  const cHi = hiPts[idx]!.codePointAt(0)!;
  const shared = loPts.slice(0, idx).join('');
  if (cHi - cLo > 1) {
    const mid = Math.floor((cLo + cHi) / 2);
    return [`${shared}${String.fromCodePoint(mid)}`, `${lo}a`, `${lo}m`];
  }
  return [`${lo}a`, `${lo}m`, `${lo}0`, `${lo}z`];
}

function bytesMidpoints(lo: Uint8Array, hi: Uint8Array): Bytes[] {
  let idx = 0;
  while (idx < lo.length && idx < hi.length && lo[idx] === hi[idx]) {
    idx += 1;
  }
  if (idx === lo.length) {
    let pos = idx;
    while (pos < hi.length && hi[pos] === 0) {
      pos += 1;
    }
    if (pos >= hi.length) return [];
    const hiByte = hi[pos]!;
    const prefix = hi.slice(0, pos);
    if (hiByte > 1) {
      return [new Bytes(new Uint8Array([...prefix, Math.floor(hiByte / 2)]))];
    }
    return [new Bytes(new Uint8Array([...prefix, 0, 128])), new Bytes(new Uint8Array([...prefix, 0, 1]))];
  }
  const bLo = lo[idx]!;
  const bHi = hi[idx]!;
  if (bHi - bLo > 1) {
    return [
      new Bytes(new Uint8Array([...lo.slice(0, idx), Math.floor((bLo + bHi) / 2)])),
      new Bytes(new Uint8Array([...lo, 1])),
    ];
  }
  return [
    new Bytes(new Uint8Array([...lo, 128])),
    new Bytes(new Uint8Array([...lo, 1])),
    new Bytes(new Uint8Array([...lo, 2])),
  ];
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
        for (let k = 0; k < 12; k += 1) {
          const candInt = firstInt + k;
          if (candInt <= hi) candidates.push(candInt);
        }
        candidates.push((lo + hi) / 2, (3 * lo + hi) / 4, (lo + 3 * hi) / 4);
        for (let k = 1; k <= 12; k += 1) {
          candidates.push(lo + ((hi - lo) * k) / 13);
        }
      } else if (lo !== undefined) {
        const baseInt = Math.floor(lo) + 1;
        for (let k = 0; k < 12; k += 1) candidates.push(baseInt + k);
        candidates.push(lo + 0.5, lo + 1);
      } else if (hi !== undefined) {
        const baseInt = Math.ceil(hi) - 1;
        for (let k = 0; k < 12; k += 1) candidates.push(baseInt - k);
        candidates.push(hi - 0.5, hi - 1);
      } else {
        for (let k = 1; k <= 15; k += 1) candidates.push(k);
      }
      break;
    }
    case 'string': {
      const lo = lower !== undefined ? (lower.val as string) : undefined;
      const hi = upper !== undefined ? (upper.val as string) : undefined;
      if (lo !== undefined && hi !== undefined) {
        for (const mid of stringMidpoints(lo, hi)) {
          candidates.push(mid, `${mid}1`, `${mid}2`);
        }
      } else if (lo !== undefined) {
        for (let k = 0; k < 12; k += 1) {
          candidates.push(`${lo}${String.fromCharCode(97 + k)}`);
        }
      } else if (hi !== undefined) {
        if (hi.length > 0) {
          for (const mid of stringMidpoints('', hi)) candidates.push(mid);
          if (hi.length > 1) candidates.push(hi.slice(0, -1));
          candidates.push('');
        }
      } else {
        for (let k = 0; k < 12; k += 1) candidates.push(`witness_${k}`);
        for (const ex of excluded) {
          if (typeof ex === 'string') candidates.push(`${ex}_alt`);
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
        for (let k = 1n; k <= 12n; k += 1n) {
          const step = ((hi - lo) * k) / 13n;
          if (step > 0n) candidates.push(build(lo + step));
        }
      } else if (lo !== undefined) {
        for (let k = 1n; k <= 12n; k += 1n) {
          candidates.push(build(lo + k * 1_000_000_000n), build(lo + k));
        }
      } else if (hi !== undefined) {
        for (let k = 1n; k <= 12n; k += 1n) {
          candidates.push(build(hi - k * 1_000_000_000n), build(hi - k));
        }
      } else {
        const base = kind === 'timestamp' ? 1_700_000_000_000_000_000n : 60_000_000_000n;
        for (let k = 1n; k <= 12n; k += 1n) {
          candidates.push(build(base + k * 1_000_000_000n));
        }
      }
      break;
    }
    case 'bytes': {
      const lo = lower !== undefined ? (lower.val as Bytes).data : undefined;
      const hi = upper !== undefined ? (upper.val as Bytes).data : undefined;
      if (lo !== undefined && hi !== undefined) {
        candidates.push(...bytesMidpoints(lo, hi));
      } else if (lo !== undefined) {
        for (let k = 1; k <= 12; k += 1) candidates.push(new Bytes(new Uint8Array([...lo, k])));
      } else if (hi !== undefined) {
        if (hi.length > 0) {
          candidates.push(...bytesMidpoints(new Uint8Array([]), hi));
          if (hi.length > 1) candidates.push(new Bytes(hi.slice(0, -1)));
          candidates.push(new Bytes(new Uint8Array([])));
        }
      } else {
        for (let k = 1; k <= 12; k += 1) candidates.push(new Bytes(new Uint8Array([k])));
      }
      break;
    }
    case 'boolean':
      candidates.push(false, true);
      break;
    case 'latlng': {
      const lo = lower !== undefined ? (lower.val as LatLng) : undefined;
      const hi = upper !== undefined ? (upper.val as LatLng) : undefined;
      if (lo && hi) {
        candidates.push(new LatLng((lo.lat + hi.lat) / 2, (lo.lng + hi.lng) / 2));
      } else if (lo) {
        if (lo.lat < 90) candidates.push(new LatLng((lo.lat + 90) / 2, lo.lng));
        if (lo.lng < 180) candidates.push(new LatLng(lo.lat, (lo.lng + 180) / 2));
      } else if (hi) {
        if (hi.lat > -90) candidates.push(new LatLng((hi.lat - 90) / 2, hi.lng));
        if (hi.lng > -180) candidates.push(new LatLng(hi.lat, (hi.lng - 180) / 2));
      } else {
        for (let k = 0; k < 12; k += 1) candidates.push(new LatLng(k, k));
      }
      break;
    }
    case 'reference': {
      const sample = (lower?.val ?? upper?.val ?? excluded.find((e) => e instanceof Reference)) as Reference | undefined;
      const dbId = sample?.databaseId ?? '(default)';
      const loPath = lower !== undefined ? (lower.val as Reference).path : undefined;
      const hiPath = upper !== undefined ? (upper.val as Reference).path : undefined;
      if (loPath !== undefined && hiPath !== undefined) {
        for (const mid of stringMidpoints(loPath, hiPath)) {
          if (mid.split('/').length % 2 === 0) candidates.push(new Reference(mid, dbId));
        }
      } else if (loPath !== undefined) {
        candidates.push(new Reference(`${loPath}a`, dbId), new Reference(`${loPath}_alt`, dbId));
      } else if (hiPath !== undefined && hiPath.length > 0) {
        for (const mid of stringMidpoints('a/a', hiPath)) {
          if (mid.split('/').length % 2 === 0) candidates.push(new Reference(mid, dbId));
        }
      } else {
        for (let k = 1; k <= 12; k += 1) candidates.push(new Reference(`col/doc_${k}`, dbId));
      }
      break;
    }
    case 'path': {
      const loSegs = lower !== undefined ? (lower.val as Path).segments : undefined;
      const hiSegs = upper !== undefined ? (upper.val as Path).segments : undefined;
      if (loSegs) {
        candidates.push(new Path([...loSegs.slice(0, -1), `${loSegs.at(-1) ?? 'doc'}a`]));
      }
      if (hiSegs && hiSegs.length > 0) {
        const last = hiSegs.at(-1) ?? '';
        if (last.length > 1) candidates.push(new Path([...hiSegs.slice(0, -1), last.slice(0, -1)]));
      }
      for (let k = 1; k <= 12; k += 1) candidates.push(new Path(['col', `doc_${k}`]));
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

  const hasArrayOp = clauses.some(
    (c) => c.op === 'array-contains' || c.op === 'array-contains-any',
  );
  if (hasArrayOp) {
    const items: unknown[] = [];
    const pushItem = (v: unknown): void => {
      if (!items.some((existing) => scalarsCompareEqual(existing, v))) {
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
    if (clauses.every((c) => clauseMatchesCandidate(items, c))) {
      return items;
    }
    return undefined;
  }

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
      !excluded.some((ex) => queryProofScalarsEqual(cand, ex) || scalarsCompareEqual(cand, ex))
      && clauses.every((c) => clauseMatchesCandidate(cand, c))
    ) {
      return cand;
    }
  }
  return undefined;
}
