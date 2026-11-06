/**
 * ─── Scenario: mixed-number-collections ──────────────────────────────────────
 * How an int and a float compare inside collections. `1 == 1.0` holds, but a
 * List or Map compares its elements by numeric type and value, so `[1] ==
 * [1.0]`, `1 in [1.0]`, `hasAll()`, `hasAny()` and `removeAll()` keep
 * them apart. A Set compares by value, so `[1.0].toSet().hasOnly([1])`
 * holds. Past 2^53 `9007199254740993 == 9007199254740992.0` holds through a
 * double, while a Set compares exact values and keeps the two apart (`b6`,
 * #1893).
 *
 * Captured by the 2026-11-03 rules engine defect hunt as `c3-mixed-number-collections`;
 * the rules and case descriptions are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: ints and floats in collections",
  rationale: "An int and the equal float are one value under ==, distinct elements in a List or Map, and one element in a Set; past 2^53 a Set keeps an int and the float it rounds to apart.",
  cases: [
    {
      "description": "s0: 1 == 1.0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "s0/1"
    },
    {
      "description": "s1: [1] == [1.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "s1/1"
    },
    {
      "description": "s2: 1 in [1.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "s2/1"
    },
    {
      "description": "s3: {'a': 1} == {'a': 1.0}",
      "expectation": "DENY",
      "method": "get",
      "path": "s3/1"
    },
    {
      "description": "s4: [1].hasAll([1.0])",
      "expectation": "DENY",
      "method": "get",
      "path": "s4/1"
    },
    {
      "description": "s5: [1.0].hasAny([1])",
      "expectation": "DENY",
      "method": "get",
      "path": "s5/1"
    },
    {
      "description": "s6: [1, 2].removeAll([1.0]) == [2]",
      "expectation": "DENY",
      "method": "get",
      "path": "s6/1"
    },
    {
      "description": "s7: {'a': [1]} == {'a': [1.0]}",
      "expectation": "DENY",
      "method": "get",
      "path": "s7/1"
    },
    {
      "description": "s8: [1.0].toSet().hasOnly([1])",
      "expectation": "ALLOW",
      "method": "get",
      "path": "s8/1"
    },
    {
      "description": "b0: 9007199254740993 == 9007199254740992.0",
      "expectation": "ALLOW",
      "method": "get",
      "path": "b0/1"
    },
    {
      "description": "b1: [9007199254740993] == [9007199254740992.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "b1/1"
    },
    {
      "description": "b2: 9007199254740993 in [9007199254740992.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "b2/1"
    },
    {
      "description": "b3: [9007199254740992] == [9007199254740992.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "b3/1"
    },
    {
      "description": "b4: 9007199254740992 in [9007199254740992.0]",
      "expectation": "DENY",
      "method": "get",
      "path": "b4/1"
    },
    {
      "description": "b5: [9007199254740993].removeAll([9007199254740992.0]) == []",
      "expectation": "DENY",
      "method": "get",
      "path": "b5/1"
    },
    {
      "description": "b6: [9007199254740993].toSet() == [9007199254740992.0].toSet()",
      "expectation": "DENY",
      "method": "get",
      "path": "b6/1"
    },
    {
      "description": "b7: 9007199254740993 != 9007199254740992.0",
      "expectation": "DENY",
      "method": "get",
      "path": "b7/1"
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /s0/{id} {\n      allow get: if 1 == 1.0;\n    }\n    match /s1/{id} {\n      allow get: if [1] == [1.0];\n    }\n    match /s2/{id} {\n      allow get: if 1 in [1.0];\n    }\n    match /s3/{id} {\n      allow get: if {'a': 1} == {'a': 1.0};\n    }\n    match /s4/{id} {\n      allow get: if [1].hasAll([1.0]);\n    }\n    match /s5/{id} {\n      allow get: if [1.0].hasAny([1]);\n    }\n    match /s6/{id} {\n      allow get: if [1, 2].removeAll([1.0]) == [2];\n    }\n    match /s7/{id} {\n      allow get: if {'a': [1]} == {'a': [1.0]};\n    }\n    match /s8/{id} {\n      allow get: if [1.0].toSet().hasOnly([1]);\n    }\n    match /b0/{id} {\n      allow get: if 9007199254740993 == 9007199254740992.0;\n    }\n    match /b1/{id} {\n      allow get: if [9007199254740993] == [9007199254740992.0];\n    }\n    match /b2/{id} {\n      allow get: if 9007199254740993 in [9007199254740992.0];\n    }\n    match /b3/{id} {\n      allow get: if [9007199254740992] == [9007199254740992.0];\n    }\n    match /b4/{id} {\n      allow get: if 9007199254740992 in [9007199254740992.0];\n    }\n    match /b5/{id} {\n      allow get: if [9007199254740993].removeAll([9007199254740992.0]) == [];\n    }\n    match /b6/{id} {\n      allow get: if [9007199254740993].toSet() == [9007199254740992.0].toSet();\n    }\n    match /b7/{id} {\n      allow get: if 9007199254740993 != 9007199254740992.0;\n    }\n  }\n}\n",
};
