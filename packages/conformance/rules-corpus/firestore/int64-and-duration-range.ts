/**
 * ─── Scenario: int64-and-duration-range ─────────────────────────────────────
 * Rules integers are signed 64-bit values. Literals and arithmetic above 2^53
 * must keep every bit (`9223372036854775807 > 9223372036854775806`,
 * `string(9007199254740993)`); `+` and `*` past the range fail at evaluation
 * rather than wrapping or going to float. Unary minus has a duration overload.
 * Timestamp plus duration and `duration.value` past the representable range
 * fail at evaluation.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: int64 and duration range",
  rationale: "Integers are 64-bit: values above 2^53 keep every bit, overflow is an evaluation error except MIN / -1, unary minus applies to durations, and timestamp or duration results out of range are errors.",
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /neg0/{id} {\n      allow get: if -duration.value(1, 's') == duration.value(-1, 's');\n    }\n    match /neg1/{id} {\n      allow get: if -duration.value(1, 's') < duration.value(0, 's');\n    }\n    match /neg2/{id} {\n      allow get: if request.time - (-duration.value(1, 'h')) > request.time;\n    }\n    match /big0/{id} {\n      allow get: if 9223372036854775807 > 9223372036854775806;\n    }\n    match /big1/{id} {\n      allow get: if 9223372036854775807 != 9223372036854775806;\n    }\n    match /big2/{id} {\n      allow get: if 9007199254740993 != 9007199254740992;\n    }\n    match /big3/{id} {\n      allow get: if 9007199254740993 - 9007199254740992 == 1;\n    }\n    match /big4/{id} {\n      allow get: if int('9007199254740993') - int('9007199254740992') == 1;\n    }\n    match /big5/{id} {\n      allow get: if string(9007199254740993) == '9007199254740993';\n    }\n    match /big6/{id} {\n      allow get: if string(9223372036854775807) == '9223372036854775807';\n    }\n    match /big7/{id} {\n      allow get: if 9007199254740991 != 9007199254740990;\n    }\n    match /ovf0/{id} {\n      allow get: if 9223372036854775807 + 1 == -9223372036854775807 - 1;\n    }\n    match /ovf1/{id} {\n      allow get: if 9223372036854775807 + 1 > 0;\n    }\n    match /ovf2/{id} {\n      allow get: if 9223372036854775807 * 2 == -2;\n    }\n    match /ovf3/{id} {\n      allow get: if -(-9223372036854775807 - 1) == -9223372036854775807 - 1;\n    }\n    match /ovf4/{id} {\n      allow get: if (-9223372036854775807 - 1) / -1 == -9223372036854775807 - 1;\n    }\n    match /ovf5/{id} {\n      allow get: if (9223372036854775807 + 1 > 0) || true;\n    }\n    match /range0/{id} {\n      allow get: if (timestamp.value(0) + duration.value(315576000000, 's')).year() == 11970;\n    }\n    match /range1/{id} {\n      allow get: if timestamp.value(253402300799999) + duration.value(1, 'ms') > timestamp.value(0);\n    }\n    match /range2/{id} {\n      allow get: if duration.value(315576000001, 's') > duration.value(0, 's');\n    }\n    match /range3/{id} {\n      allow get: if duration.value(315576000000, 's') > duration.value(0, 's');\n    }\n    match /range4/{id} {\n      allow get: if timestamp.value(253402300800000) > timestamp.value(0);\n    }\n  }\n}\n",
  cases: [
  {
    "description": "neg duration equals duration.value(-1, 's')",
    "expectation": "ALLOW",
    "method": "get",
    "path": "neg0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "neg duration is less than zero",
    "expectation": "ALLOW",
    "method": "get",
    "path": "neg1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "request.time minus a negated hour is later",
    "expectation": "ALLOW",
    "method": "get",
    "path": "neg2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "int64 max is greater than max minus one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "int64 max differs from max minus one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "2^53 plus one differs from 2^53",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "2^53 plus one minus 2^53 is one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "int() of 2^53 plus one keeps the low bit",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big4/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "string() of 2^53 plus one",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big5/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "string() of int64 max",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big6/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "control below 2^53",
    "expectation": "ALLOW",
    "method": "get",
    "path": "big7/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "max plus one wraps to min",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ovf0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "max plus one is positive",
    "expectation": "DENY",
    "method": "get",
    "path": "ovf1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "max times two wraps to minus two",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ovf2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "negated min is min",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ovf3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "min divided by minus one is min",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ovf4/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "overflow or true",
    "expectation": "ALLOW",
    "method": "get",
    "path": "ovf5/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "epoch plus 315576000000 s has year 11970",
    "expectation": "DENY",
    "method": "get",
    "path": "range0/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "max timestamp plus 1 ms is later",
    "expectation": "DENY",
    "method": "get",
    "path": "range1/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "duration past the protobuf bound is positive",
    "expectation": "DENY",
    "method": "get",
    "path": "range2/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "duration at the protobuf bound is positive",
    "expectation": "ALLOW",
    "method": "get",
    "path": "range3/1",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "timestamp.value past year 9999 (control)",
    "expectation": "DENY",
    "method": "get",
    "path": "range4/1",
    "requestTime": "2026-01-01T00:00:00Z"
  }
],
};
