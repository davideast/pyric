/**
 * ─── Scenario: int64-conversions-and-mixed-equality ──────────────────────────
 * int64 at its edges and an int against a float. `int()` of a string past
 * int64, with a space, a fraction, hex or an exponent is a type conversion
 * error; `int()` of a float saturates and maps NaN to 0. `math.abs(MIN)` is
 * MIN, `MIN * -1` and `-MIN` are out of range, and `math.round` rounds
 * halves away from zero. `9007199254740993 == 9007199254740992.0` holds
 * through a double, while a List, a Map, a Set and a map diff keep the two
 * apart (`eq7` and `eq8`, #1893).
 *
 * Captured by the 2026-11-03 rules engine defect hunt as `c2-numbers`;
 * the rules and case descriptions are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: int64 conversions and mixed int and float equality",
  rationale: "int() of strings and floats saturates or fails as production does, math functions and int64 overflow keep production's results, and an int and a float past 2^53 are equal under == but distinct in a List, a Map, a Set and a map diff.",
  cases: [
    {
      "description": "ab0: math.abs((-9223372036854775807 - 1)) == (-9223372036854775807 - 1)",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ab0/1"
    },
    {
      "description": "ab1: math.abs((-9223372036854775807 - 1)) > 0",
      "expectation": "DENY",
      "method": "get",
      "path": "ab1/1"
    },
    {
      "description": "ab2: math.abs((-9223372036854775807 - 1)) == 0 || true",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ab2/1"
    },
    {
      "description": "in0: int('9223372036854775807') == 9223372036854775807",
      "expectation": "ALLOW",
      "method": "get",
      "path": "in0/1"
    },
    {
      "description": "in1: int('9223372036854775808') == 9223372036854775807",
      "expectation": "DENY",
      "method": "get",
      "path": "in1/1"
    },
    {
      "description": "in2: int('9223372036854775808') > 0 || int('9223372036854775808') <= 0",
      "expectation": "DENY",
      "method": "get",
      "path": "in2/1"
    },
    {
      "description": "in3: int('-9223372036854775808') == (-9223372036854775807 - 1)",
      "expectation": "ALLOW",
      "method": "get",
      "path": "in3/1"
    },
    {
      "description": "in4: int('+1') == 1",
      "expectation": "ALLOW",
      "method": "get",
      "path": "in4/1"
    },
    {
      "description": "in5: int(' 1') == 1",
      "expectation": "DENY",
      "method": "get",
      "path": "in5/1"
    },
    {
      "description": "in6: int('1.5') == 1",
      "expectation": "DENY",
      "method": "get",
      "path": "in6/1"
    },
    {
      "description": "in7: int('0x10') == 16",
      "expectation": "DENY",
      "method": "get",
      "path": "in7/1"
    },
    {
      "description": "in8: int('-0') == 0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "in8/1"
    },
    {
      "description": "in9: int('1e3') == 1000",
      "expectation": "DENY",
      "method": "get",
      "path": "in9/1"
    },
    {
      "description": "if0: int(float('1e19')) == 9223372036854775807",
      "expectation": "ALLOW",
      "method": "get",
      "path": "if0/1"
    },
    {
      "description": "if1: int(float('-1e19')) == (-9223372036854775807 - 1)",
      "expectation": "ALLOW",
      "method": "get",
      "path": "if1/1"
    },
    {
      "description": "if2: int(float('NaN')) == 0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "if2/1"
    },
    {
      "description": "if3: int(float('Infinity')) == 9223372036854775807",
      "expectation": "ALLOW",
      "method": "get",
      "path": "if3/1"
    },
    {
      "description": "if4: int(-2.7) == -2",
      "expectation": "ALLOW",
      "method": "get",
      "path": "if4/1"
    },
    {
      "description": "fl0: float(9007199254740993) == 9007199254740992.0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "fl0/1"
    },
    {
      "description": "eq0: 9007199254740993 == 9007199254740992.0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "eq0/1"
    },
    {
      "description": "eq1: [9007199254740993] == [9007199254740992.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "eq1/1"
    },
    {
      "description": "eq2: 9007199254740993 in [9007199254740992.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "eq2/1"
    },
    {
      "description": "eq3: {'a': 9007199254740993} == {'a': 9007199254740992.0}",
      "expectation": "DENY",
      "method": "get",
      "path": "eq3/1"
    },
    {
      "description": "eq4: [1, 1.0].toSet().size() == 1",
      "expectation": "ALLOW",
      "method": "get",
      "path": "eq4/1"
    },
    {
      "description": "eq5: [1].toSet() == [1.0].toSet()",
      "expectation": "ALLOW",
      "method": "get",
      "path": "eq5/1"
    },
    {
      "description": "eq6: {'a': 1}.diff({'a': 1.0}).affectedKeys().size() == 0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "eq6/1"
    },
    {
      "description": "eq7: 9007199254740993 in [9007199254740992.0].toSet()",
      "expectation": "DENY",
      "method": "get",
      "path": "eq7/1"
    },
    {
      "description": "eq8: {'a': 9007199254740993}.diff({'a': 9007199254740992.0}).affectedKeys().size() == 0",
      "expectation": "DENY",
      "method": "get",
      "path": "eq8/1"
    },
    {
      "description": "eq9: [9007199254740993].hasAll([9007199254740992.0])",
      "expectation": "DENY",
      "method": "get",
      "path": "eq9/1"
    },
    {
      "description": "ma0: math.floor(2.5) == 2",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma0/1"
    },
    {
      "description": "ma1: math.floor(2.5) is int",
      "expectation": "DENY",
      "method": "get",
      "path": "ma1/1"
    },
    {
      "description": "ma2: math.ceil(float('1e300')) == 9223372036854775807",
      "expectation": "DENY",
      "method": "get",
      "path": "ma2/1"
    },
    {
      "description": "ma3: math.round(-2.5) == -3",
      "expectation": "DENY",
      "method": "get",
      "path": "ma3/1"
    },
    {
      "description": "ma4: math.round(-2.5) == -2",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma4/1"
    },
    {
      "description": "ma5: math.round(2.5) == 3",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma5/1"
    },
    {
      "description": "ma6: int(math.pow(2, 63)) == 9223372036854775807",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma6/1"
    },
    {
      "description": "ma7: math.floor(-0.5) == -1",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma7/1"
    },
    {
      "description": "ma8: math.abs(-0.0) == 0.0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma8/1"
    },
    {
      "description": "ma9: math.sqrt(-1.0) > 0 || math.isNaN(math.sqrt(-1.0))",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ma9/1"
    },
    {
      "description": "ov0: ((-9223372036854775807 - 1) * -1) < 0",
      "expectation": "DENY",
      "method": "get",
      "path": "ov0/1"
    },
    {
      "description": "ov1: ((-9223372036854775807 - 1) * -1) > 0",
      "expectation": "DENY",
      "method": "get",
      "path": "ov1/1"
    },
    {
      "description": "ov2: ((-9223372036854775807 - 1) % -1) == 0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ov2/1"
    },
    {
      "description": "ov3: -(-9223372036854775807 - 1) < 0",
      "expectation": "DENY",
      "method": "get",
      "path": "ov3/1"
    },
    {
      "description": "ov4: string((-9223372036854775807 - 1)) == '-9223372036854775808'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ov4/1"
    },
    {
      "description": "ov5: 9223372036854775807 * -1 == -9223372036854775807",
      "expectation": "ALLOW",
      "method": "get",
      "path": "ov5/1"
    },
    {
      "description": "fd0: math.isInfinite(1 / 0.0)",
      "expectation": "DENY",
      "method": "get",
      "path": "fd0/1"
    },
    {
      "description": "fd1: math.isInfinite(1.0 / 0)",
      "expectation": "DENY",
      "method": "get",
      "path": "fd1/1"
    },
    {
      "description": "fd2: math.isNaN(0.0 / 0.0)",
      "expectation": "ALLOW",
      "method": "get",
      "path": "fd2/1"
    },
    {
      "description": "fd3: 5 % 2.0 == 1.0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "fd3/1"
    },
    {
      "description": "fd4: -5.5 % 2 == -1.5",
      "expectation": "ALLOW",
      "method": "get",
      "path": "fd4/1"
    },
    {
      "description": "fd5: math.isNaN(1.0 % 0)",
      "expectation": "ALLOW",
      "method": "get",
      "path": "fd5/1"
    },
    {
      "description": "fd6: 7 / 2.0 == 3.5",
      "expectation": "ALLOW",
      "method": "get",
      "path": "fd6/1"
    },
    {
      "description": "du0: duration.value(9223372036854775807, 's') > duration.value(0, 's') || true",
      "expectation": "ALLOW",
      "method": "get",
      "path": "du0/1"
    },
    {
      "description": "du1: duration.value(9223372036854775807, 'ns') > duration.value(0, 's')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "du1/1"
    },
    {
      "description": "du2: duration.value(1, 'w') == duration.value(7, 'd')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "du2/1"
    },
    {
      "description": "du3: duration.time(0, 0, 0, 9223372036854775807) > duration.value(0, 's')",
      "expectation": "ALLOW",
      "method": "get",
      "path": "du3/1"
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /ab0/{id} {\n      allow get: if math.abs((-9223372036854775807 - 1)) == (-9223372036854775807 - 1);\n    }\n    match /ab1/{id} {\n      allow get: if math.abs((-9223372036854775807 - 1)) > 0;\n    }\n    match /ab2/{id} {\n      allow get: if math.abs((-9223372036854775807 - 1)) == 0 || true;\n    }\n    match /in0/{id} {\n      allow get: if int('9223372036854775807') == 9223372036854775807;\n    }\n    match /in1/{id} {\n      allow get: if int('9223372036854775808') == 9223372036854775807;\n    }\n    match /in2/{id} {\n      allow get: if int('9223372036854775808') > 0 || int('9223372036854775808') <= 0;\n    }\n    match /in3/{id} {\n      allow get: if int('-9223372036854775808') == (-9223372036854775807 - 1);\n    }\n    match /in4/{id} {\n      allow get: if int('+1') == 1;\n    }\n    match /in5/{id} {\n      allow get: if int(' 1') == 1;\n    }\n    match /in6/{id} {\n      allow get: if int('1.5') == 1;\n    }\n    match /in7/{id} {\n      allow get: if int('0x10') == 16;\n    }\n    match /in8/{id} {\n      allow get: if int('-0') == 0;\n    }\n    match /in9/{id} {\n      allow get: if int('1e3') == 1000;\n    }\n    match /if0/{id} {\n      allow get: if int(float('1e19')) == 9223372036854775807;\n    }\n    match /if1/{id} {\n      allow get: if int(float('-1e19')) == (-9223372036854775807 - 1);\n    }\n    match /if2/{id} {\n      allow get: if int(float('NaN')) == 0;\n    }\n    match /if3/{id} {\n      allow get: if int(float('Infinity')) == 9223372036854775807;\n    }\n    match /if4/{id} {\n      allow get: if int(-2.7) == -2;\n    }\n    match /fl0/{id} {\n      allow get: if float(9007199254740993) == 9007199254740992.0;\n    }\n    match /eq0/{id} {\n      allow get: if 9007199254740993 == 9007199254740992.0;\n    }\n    match /eq1/{id} {\n      allow get: if [9007199254740993] == [9007199254740992.0];\n    }\n    match /eq2/{id} {\n      allow get: if 9007199254740993 in [9007199254740992.0];\n    }\n    match /eq3/{id} {\n      allow get: if {'a': 9007199254740993} == {'a': 9007199254740992.0};\n    }\n    match /eq4/{id} {\n      allow get: if [1, 1.0].toSet().size() == 1;\n    }\n    match /eq5/{id} {\n      allow get: if [1].toSet() == [1.0].toSet();\n    }\n    match /eq6/{id} {\n      allow get: if {'a': 1}.diff({'a': 1.0}).affectedKeys().size() == 0;\n    }\n    match /eq7/{id} {\n      allow get: if 9007199254740993 in [9007199254740992.0].toSet();\n    }\n    match /eq8/{id} {\n      allow get: if {'a': 9007199254740993}.diff({'a': 9007199254740992.0}).affectedKeys().size() == 0;\n    }\n    match /eq9/{id} {\n      allow get: if [9007199254740993].hasAll([9007199254740992.0]);\n    }\n    match /ma0/{id} {\n      allow get: if math.floor(2.5) == 2;\n    }\n    match /ma1/{id} {\n      allow get: if math.floor(2.5) is int;\n    }\n    match /ma2/{id} {\n      allow get: if math.ceil(float('1e300')) == 9223372036854775807;\n    }\n    match /ma3/{id} {\n      allow get: if math.round(-2.5) == -3;\n    }\n    match /ma4/{id} {\n      allow get: if math.round(-2.5) == -2;\n    }\n    match /ma5/{id} {\n      allow get: if math.round(2.5) == 3;\n    }\n    match /ma6/{id} {\n      allow get: if int(math.pow(2, 63)) == 9223372036854775807;\n    }\n    match /ma7/{id} {\n      allow get: if math.floor(-0.5) == -1;\n    }\n    match /ma8/{id} {\n      allow get: if math.abs(-0.0) == 0.0;\n    }\n    match /ma9/{id} {\n      allow get: if math.sqrt(-1.0) > 0 || math.isNaN(math.sqrt(-1.0));\n    }\n    match /ov0/{id} {\n      allow get: if ((-9223372036854775807 - 1) * -1) < 0;\n    }\n    match /ov1/{id} {\n      allow get: if ((-9223372036854775807 - 1) * -1) > 0;\n    }\n    match /ov2/{id} {\n      allow get: if ((-9223372036854775807 - 1) % -1) == 0;\n    }\n    match /ov3/{id} {\n      allow get: if -(-9223372036854775807 - 1) < 0;\n    }\n    match /ov4/{id} {\n      allow get: if string((-9223372036854775807 - 1)) == '-9223372036854775808';\n    }\n    match /ov5/{id} {\n      allow get: if 9223372036854775807 * -1 == -9223372036854775807;\n    }\n    match /fd0/{id} {\n      allow get: if math.isInfinite(1 / 0.0);\n    }\n    match /fd1/{id} {\n      allow get: if math.isInfinite(1.0 / 0);\n    }\n    match /fd2/{id} {\n      allow get: if math.isNaN(0.0 / 0.0);\n    }\n    match /fd3/{id} {\n      allow get: if 5 % 2.0 == 1.0;\n    }\n    match /fd4/{id} {\n      allow get: if -5.5 % 2 == -1.5;\n    }\n    match /fd5/{id} {\n      allow get: if math.isNaN(1.0 % 0);\n    }\n    match /fd6/{id} {\n      allow get: if 7 / 2.0 == 3.5;\n    }\n    match /du0/{id} {\n      allow get: if duration.value(9223372036854775807, 's') > duration.value(0, 's') || true;\n    }\n    match /du1/{id} {\n      allow get: if duration.value(9223372036854775807, 'ns') > duration.value(0, 's');\n    }\n    match /du2/{id} {\n      allow get: if duration.value(1, 'w') == duration.value(7, 'd');\n    }\n    match /du3/{id} {\n      allow get: if duration.time(0, 0, 0, 9223372036854775807) > duration.value(0, 's');\n    }\n  }\n}\n",
};
