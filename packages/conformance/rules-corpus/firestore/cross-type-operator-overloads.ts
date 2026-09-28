/**
 * ─── Scenario 4: cross-type-operator-overloads ────────────────────────────────
 * Targets Item 2 of the rebuild plan — operator overloads in
 * `evaluateBinaryOp` for Timestamp/Duration cross-type arithmetic. Pre-fix
 * (before Item 1.2/1.3), the namespace constructors returned bare epoch-ms
 * Numbers, so `Timestamp + Duration` was silent numeric add and the
 * resulting "Timestamp" lost its type identity. Production evaluates the
 * type-preserving cases natively. This scenario proves the simulator now
 * matches across all four cross-type arithmetic forms plus `<` `>`
 * comparisons that depend on the wrappers' field-wise compareTo (not
 * numeric coercion).
 *
 * The plusOperand cases pin `+` across operand types. Production's `+`
 * accepts int + int, float + float (int + float promotes), string + string,
 * and the duration and timestamp pairs above. list + list, list + string,
 * string + list, string + int, int + string, and map + map are error values:
 * each denies as a bare comparison, denies through `!=`, and `|| true`
 * absorbs it. `list.concat(list)` is the documented way to join two lists.
 * Operands come from literals and from request data, so the pair is
 * evaluated at request time. string + timestamp (literal and
 * `request.time`), timestamp + string, string + duration, duration + string,
 * timestamp + timestamp, string + bytes, bytes + string, bytes + bytes,
 * duration + int, and int + duration are error values too, each pinned as a
 * bare condition, as a `!=` witness, and under `|| true`.
 */
import type { ScenarioRecord } from './types.ts';

interface PlusOperandCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
  /** Pins `request.time`; the Rules Test API leaves it undefined otherwise. */
  requestTime?: string;
}

const d = 'request.resource.data';

const plusOperands: PlusOperandCase[] = [
  { key: 'listLiteralEq', condition: '[1] + [2] == [1, 2]', expectation: 'DENY' },
  { key: 'listLiteralNeq', condition: '[1] + [2] != [9]', expectation: 'DENY' },
  { key: 'listLiteralOrTrue', condition: '([1] + [2] == [1, 2]) || true', expectation: 'ALLOW' },
  { key: 'listDataEq', condition: `${d}.a + ${d}.b == ['a', 'b', 'c', 'd']`, expectation: 'DENY' },
  { key: 'listDataNeq', condition: `${d}.a + ${d}.b != ['z']`, expectation: 'DENY' },
  { key: 'listDataOrTrue', condition: `(${d}.a + ${d}.b == ['a', 'b', 'c', 'd']) || true`, expectation: 'ALLOW' },
  { key: 'listStringNeq', condition: `${d}.a + ${d}.s != ['z']`, expectation: 'DENY' },
  { key: 'listStringOrTrue', condition: `(${d}.a + ${d}.s != ['z']) || true`, expectation: 'ALLOW' },
  { key: 'stringListNeq', condition: `${d}.s + ${d}.a != 'z'`, expectation: 'DENY' },
  { key: 'stringListOrTrue', condition: `(${d}.s + ${d}.a != 'z') || true`, expectation: 'ALLOW' },
  { key: 'stringIntNeq', condition: `${d}.s + ${d}.n != 'z'`, expectation: 'DENY' },
  { key: 'stringIntOrTrue', condition: `(${d}.s + ${d}.n != 'z') || true`, expectation: 'ALLOW' },
  { key: 'stringIntLiteralNeq', condition: "'a' + 1 != 'x'", expectation: 'DENY' },
  { key: 'intStringNeq', condition: `${d}.n + ${d}.s != 'z'`, expectation: 'DENY' },
  { key: 'intStringOrTrue', condition: `(${d}.n + ${d}.s != 'z') || true`, expectation: 'ALLOW' },
  { key: 'mapMapNeq', condition: `${d}.m + {'b': 'c'} != {}`, expectation: 'DENY' },
  { key: 'mapMapOrTrue', condition: `(${d}.m + {'b': 'c'} != {}) || true`, expectation: 'ALLOW' },
  { key: 'stringStringEq', condition: `${d}.s + '/x' == 'ab/x' && 'a' + 'b' == 'ab'`, expectation: 'ALLOW' },
  { key: 'stringStringNeq', condition: `${d}.s + 'c' != 'abc'`, expectation: 'DENY' },
  { key: 'stringStringOrTrue', condition: `(${d}.s + 'c' != 'abc') || true`, expectation: 'ALLOW' },
  { key: 'intFloatEq', condition: `${d}.n + 1.5 == 4.5 && 1.5 + 1 == 2.5`, expectation: 'ALLOW' },
  { key: 'intFloatNeq', condition: `${d}.n + 1.5 != 4.5`, expectation: 'DENY' },
  { key: 'intFloatOrTrue', condition: `(${d}.n + 1.5 != 4.5) || true`, expectation: 'ALLOW' },
  { key: 'concatDataEq', condition: `${d}.a.concat(${d}.b) == ['a', 'b', 'c', 'd']`, expectation: 'ALLOW' },
  { key: 'concatLiteralEq', condition: '[1].concat([2]) == [1, 2]', expectation: 'ALLOW' },
  { key: 'concatLiteralNeq', condition: '[1].concat([2]) != [1, 2]', expectation: 'DENY' },
  ...wrapperPlusOperands(),
];

interface WrapperPair {
  key: string;
  sum: string;
  requestTime?: string;
  /** A value the sum cannot equal, so `!=` is true whenever `+` produces a value. */
  sentinel: string;
}

/** `+` with a timestamp, duration, or bytes operand, each pair as a bare
 *  condition, as a `!=` witness that is true whenever `+` produces a value,
 *  and as that witness under `|| true`. */
function wrapperPlusOperands(): PlusOperandCase[] {
  const pairs: WrapperPair[] = [
    { key: 'stringTimestamp', sum: "'at ' + timestamp.value(0)", sentinel: "'z'" },
    { key: 'stringRequestTime', sum: "'at ' + request.time", sentinel: "'z'", requestTime: '2026-01-01T00:00:00.000Z' },
    { key: 'timestampString', sum: "timestamp.value(0) + ' at'", sentinel: "'z'" },
    { key: 'stringDuration', sum: "'for ' + duration.value(60, 's')", sentinel: "'z'" },
    { key: 'durationString', sum: "duration.value(60, 's') + ' later'", sentinel: "'z'" },
    { key: 'timestampTimestamp', sum: 'timestamp.value(0) + timestamp.value(60000)', sentinel: 'timestamp.value(1)' },
    { key: 'stringBytes', sum: "'a' + 'b'.toUtf8()", sentinel: "'z'" },
    { key: 'bytesString', sum: "'a'.toUtf8() + 'b'", sentinel: "'z'" },
    { key: 'bytesBytes', sum: "'ab'.toUtf8() + 'cd'.toUtf8()", sentinel: "'zz'.toUtf8()" },
    { key: 'durationInt', sum: "duration.value(60, 's') + 1", sentinel: "duration.value(1, 's')" },
    { key: 'intDuration', sum: "1 + duration.value(60, 's')", sentinel: "duration.value(1, 's')" },
  ];
  return pairs.flatMap(({ key, sum, sentinel, requestTime }): PlusOperandCase[] => [
    { key: `${key}Bare`, condition: sum, expectation: 'DENY', requestTime },
    { key: `${key}Neq`, condition: `${sum} != ${sentinel}`, expectation: 'DENY', requestTime },
    { key: `${key}OrTrue`, condition: `(${sum} != ${sentinel}) || true`, expectation: 'ALLOW', requestTime },
  ]).concat([
    { key: 'bytesBytesEq', condition: "'ab'.toUtf8() + 'cd'.toUtf8() == 'abcd'.toUtf8()", expectation: 'DENY' },
  ]);
}

const plusOperandBlocks = plusOperands
  .map(({ key, condition }) => `    match /plusOperand/${key}/{id} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Item 2',
  rationale: 'Wrapper binaryOp must produce typed results for Timestamp/Duration cross-type ops; numeric coercion would silently lose type identity and (post-Risk 2 guard) silently DENY.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Timestamp + Duration → Timestamp
    match /tsPlusDurAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(0) + duration.value(60, 's') == timestamp.value(60000);
    }
    // Timestamp - Duration → Timestamp
    match /tsMinusDurAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(60000) - duration.value(60, 's') == timestamp.value(0);
    }
    // Timestamp - Timestamp → Duration
    match /tsMinusTsAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(60000) - timestamp.value(0) == duration.value(60, 's');
    }
    // Duration + Duration → Duration
    match /durPlusDurAllow/{id} {
      allow create: if request.auth != null
        && duration.value(30, 's') + duration.value(30, 's') == duration.value(60, 's');
    }
    // Duration - Duration → Duration
    match /durMinusDurAllow/{id} {
      allow create: if request.auth != null
        && duration.value(60, 's') - duration.value(30, 's') == duration.value(30, 's');
    }
    // Timestamp comparison via field-wise compareTo (not numeric coercion)
    match /tsLessThanAllow/{id} {
      allow create: if request.auth != null
        && timestamp.date(2025, 1, 1) < timestamp.date(2099, 1, 1);
    }
    // DENY witness — wrong arithmetic should still fail
    match /tsPlusDurDeny/{id} {
      allow create: if request.auth != null
        && timestamp.value(0) + duration.value(60, 's') == timestamp.value(0);
    }
${plusOperandBlocks}
  }
}`,
  cases: [
    {
      description: 'Timestamp + Duration → Timestamp ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsPlusDurAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp - Duration → Timestamp ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsMinusDurAllow/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp - Timestamp → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsMinusTsAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Duration + Duration → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'durPlusDurAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Duration - Duration → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'durMinusDurAllow/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp < Timestamp via field compare ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsLessThanAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'wrong arithmetic — Timestamp + Duration ≠ original Timestamp DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'tsPlusDurDeny/d7',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    ...plusOperands.map(({ key, condition, expectation, requestTime }) => ({
      description: `plusOperand ${key}: ${condition} → ${expectation}`,
      expectation,
      method: 'create' as const,
      path: `plusOperand/${key}/d1`,
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'], b: ['c', 'd'], s: 'ab', n: 3, m: { k: 'v' } },
      ...(requestTime === undefined ? {} : { requestTime }),
    })),
  ],
  group: 'stress',
};
