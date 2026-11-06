/**
 * ─── Scenario: interpolated-lookup-path-segments ────────────────────────────
 * A `$(value)` in a get() or exists() path is one path segment, whatever it
 * holds. A value holding `/` names no document, so the lookup errors and the
 * request is denied (#1888, hunt finding FS3-SIM-1). The controls read a
 * plain id, a literal deeper path, and a path built with path() from a
 * concatenated string, which production splits on `/`.
 * Rules and cases are the hunt capture `c7a-interp-lookups` as sent.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "FS3-SIM-1",
  rationale: "An interpolated string holding '/' is one lookup path segment, so it names no document; pyric read it as the deeper document.",
  rules: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /ex0/{id} {\n      allow create: if exists(/databases/$(database)/documents/allowed/$(request.resource.data.k));\n    }\n    match /ex1/{id} {\n      allow create: if exists(/databases/$(database)/documents/allowed/$(request.resource.data.k));\n    }\n    match /ex2/{id} {\n      allow create: if !exists(/databases/$(database)/documents/allowed/$(request.resource.data.k));\n    }\n    match /ex3/{id} {\n      allow create: if exists(/databases/$(database)/documents/allowed/$(request.resource.data.k)) || true;\n    }\n    match /ge0/{id} {\n      allow create: if get(/databases/$(database)/documents/users/$(request.resource.data.owner)).data.role == 'admin';\n    }\n    match /ge1/{id} {\n      allow create: if get(/databases/$(database)/documents/users/$(request.resource.data.owner)).data.role == 'admin';\n    }\n    match /ex4/{id} {\n      allow create: if exists(/databases/$(database)/documents/allowed/x/sub/$(request.resource.data.k));\n    }\n    match /ex5/{id} {\n      allow create: if exists(path('/databases/' + database + '/documents/allowed/' + request.resource.data.k));\n    }\n  }\n}\n",
  cases: [
  {
    "description": "ex0: exists(/databases/$(database)/documents/allowed/$(request.resource.data.k))",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ex0/1",
    "data": {
      "k": "x"
    },
    "functionMocks": [
      {
        "function": "exists",
        "path": "allowed/x",
        "result": true
      }
    ]
  },
  {
    "description": "ex1: exists(/databases/$(database)/documents/allowed/$(request.resource.data.k))",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ex1/1",
    "data": {
      "k": "x/sub/y"
    },
    "functionMocks": [
      {
        "function": "exists",
        "path": "allowed/x/sub/y",
        "result": true
      }
    ]
  },
  {
    "description": "ex2: !exists(/databases/$(database)/documents/allowed/$(request.resource.data.k))",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ex2/1",
    "data": {
      "k": "x/sub/y"
    },
    "functionMocks": [
      {
        "function": "exists",
        "path": "allowed/x/sub/y",
        "result": true
      }
    ]
  },
  {
    "description": "ex3: exists(/databases/$(database)/documents/allowed/$(request.resource.data.k)) || true",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ex3/1",
    "data": {
      "k": "x/sub/y"
    },
    "functionMocks": [
      {
        "function": "exists",
        "path": "allowed/x/sub/y",
        "result": true
      }
    ]
  },
  {
    "description": "ge0: get(/databases/$(database)/documents/users/$(request.resource.data.owner)).data.role == 'admin'",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ge0/1",
    "data": {
      "owner": "u1/keys/k1"
    },
    "functionMocks": [
      {
        "function": "get",
        "path": "users/u1/keys/k1",
        "result": {
          "role": "admin"
        }
      }
    ]
  },
  {
    "description": "ge1: get(/databases/$(database)/documents/users/$(request.resource.data.owner)).data.role == 'admin'",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ge1/1",
    "data": {
      "owner": "u1"
    },
    "functionMocks": [
      {
        "function": "get",
        "path": "users/u1",
        "result": {
          "role": "admin"
        }
      }
    ]
  },
  {
    "description": "ex4: exists(/databases/$(database)/documents/allowed/x/sub/$(request.resource.data.k))",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ex4/1",
    "data": {
      "k": "y"
    },
    "functionMocks": [
      {
        "function": "exists",
        "path": "allowed/x/sub/y",
        "result": true
      }
    ]
  },
  {
    "description": "ex5: exists(path('/databases/' + database + '/documents/allowed/' + request.resource.data.k))",
    "expectation": "ALLOW",
    "method": "create",
    "path": "ex5/1",
    "data": {
      "k": "x/sub/y"
    },
    "functionMocks": [
      {
        "function": "exists",
        "path": "allowed/x/sub/y",
        "result": true
      }
    ]
  }
],
};
