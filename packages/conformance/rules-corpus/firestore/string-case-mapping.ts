/**
 * ─── Scenario: string-case-mapping ───────────────────────────────────────────
 * How `lower()` and `upper()` map case. Production maps the ASCII
 * letters only: `'aB'.upper() == 'AB'` holds, while `'é'.upper()`,
 * `'Ä'.lower()`, `'ж'.upper()`, `'ß'.upper()`, `'İ'.lower()` and
 * `'ａ'.upper()` return their receiver unchanged, so
 * `'ÉVE@X.COM'.lower() == 'Éve@x.com'` holds and the same check against
 * request data with `ÉVE@X.COM` denies `== 'éve@x.com'` (`cmg`).
 * pyric maps every Unicode letter, so 15 of the 17 cases differ (#1896).
 *
 * Captured by the 2026-11-03 rules engine defect hunt as `c11-case-mapping`;
 * the rules and case descriptions are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: lower() and upper() case mapping",
  rationale: "lower() and upper() map the ASCII letters A-Z and a-z only; every other letter, including é, Ä, Σ, ж, ß, İ and fullwidth ａ, keeps its case.",
  cases: [
    {
      "description": "cm0: 'aB'.upper() == 'AB'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cm0/1"
    },
    {
      "description": "cm1: 'é'.upper() == 'É'",
      "expectation": "DENY",
      "method": "get",
      "path": "cm1/1"
    },
    {
      "description": "cm2: 'é'.upper() == 'é'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cm2/1"
    },
    {
      "description": "cm3: 'Ä'.lower() == 'ä'",
      "expectation": "DENY",
      "method": "get",
      "path": "cm3/1"
    },
    {
      "description": "cm4: 'Ä'.lower() == 'Ä'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cm4/1"
    },
    {
      "description": "cm5: 'ΑΣ'.lower() == 'ασ'",
      "expectation": "DENY",
      "method": "get",
      "path": "cm5/1"
    },
    {
      "description": "cm6: 'ΑΣ'.lower() == 'ΑΣ'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cm6/1"
    },
    {
      "description": "cm7: 'ж'.upper() == 'Ж'",
      "expectation": "DENY",
      "method": "get",
      "path": "cm7/1"
    },
    {
      "description": "cm8: 'ж'.upper() == 'ж'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cm8/1"
    },
    {
      "description": "cm9: 'aé'.upper() == 'Aé'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cm9/1"
    },
    {
      "description": "cma: 'ÉVE@X.COM'.lower() == 'éve@x.com'",
      "expectation": "DENY",
      "method": "get",
      "path": "cma/1"
    },
    {
      "description": "cmb: 'ÉVE@X.COM'.lower() == 'Éve@x.com'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cmb/1"
    },
    {
      "description": "cmc: 'ß'.upper() == 'SS'",
      "expectation": "DENY",
      "method": "get",
      "path": "cmc/1"
    },
    {
      "description": "cmd: 'ß'.upper() == 'ß'",
      "expectation": "ALLOW",
      "method": "get",
      "path": "cmd/1"
    },
    {
      "description": "cme: 'İ'.lower().size() == 2",
      "expectation": "DENY",
      "method": "get",
      "path": "cme/1"
    },
    {
      "description": "cmf: 'ａ'.upper() == 'Ａ'",
      "expectation": "DENY",
      "method": "get",
      "path": "cmf/1"
    },
    {
      "description": "cmg: request.resource.data.email.lower() == 'éve@x.com'",
      "expectation": "DENY",
      "method": "create",
      "path": "cmg/1",
      "data": {
        "email": "ÉVE@X.COM"
      }
    }
  ],
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /cm0/{id} {\n      allow get: if 'aB'.upper() == 'AB';\n    }\n    match /cm1/{id} {\n      allow get: if 'é'.upper() == 'É';\n    }\n    match /cm2/{id} {\n      allow get: if 'é'.upper() == 'é';\n    }\n    match /cm3/{id} {\n      allow get: if 'Ä'.lower() == 'ä';\n    }\n    match /cm4/{id} {\n      allow get: if 'Ä'.lower() == 'Ä';\n    }\n    match /cm5/{id} {\n      allow get: if 'ΑΣ'.lower() == 'ασ';\n    }\n    match /cm6/{id} {\n      allow get: if 'ΑΣ'.lower() == 'ΑΣ';\n    }\n    match /cm7/{id} {\n      allow get: if 'ж'.upper() == 'Ж';\n    }\n    match /cm8/{id} {\n      allow get: if 'ж'.upper() == 'ж';\n    }\n    match /cm9/{id} {\n      allow get: if 'aé'.upper() == 'Aé';\n    }\n    match /cma/{id} {\n      allow get: if 'ÉVE@X.COM'.lower() == 'éve@x.com';\n    }\n    match /cmb/{id} {\n      allow get: if 'ÉVE@X.COM'.lower() == 'Éve@x.com';\n    }\n    match /cmc/{id} {\n      allow get: if 'ß'.upper() == 'SS';\n    }\n    match /cmd/{id} {\n      allow get: if 'ß'.upper() == 'ß';\n    }\n    match /cme/{id} {\n      allow get: if 'İ'.lower().size() == 2;\n    }\n    match /cmf/{id} {\n      allow get: if 'ａ'.upper() == 'Ａ';\n    }\n    match /cmg/{id} {\n      allow create: if request.resource.data.email.lower() == 'éve@x.com';\n    }\n  }\n}\n",
};
