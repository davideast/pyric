/**
 * ─── Scenario: rules-version-1-recursive-glob ───────────────────────────────
 * A ruleset with no `rules_version` is version 1. In version 1 a recursive
 * wildcard matches one or more segments, never zero, so
 * `/cities/{city}/{document=**}` matches documents in subcollections of a city
 * but not the city document itself.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: "Coverage: rules_version 1 recursive wildcard",
  rationale: "Without rules_version = '2' a recursive wildcard does not match an empty path: /cities/{city}/{document=**} does not match cities/SF.",
  rules: "service cloud.firestore {\n  match /databases/{database}/documents {\n    match /cities/{city}/{document=**} {\n      allow get: if true;\n    }\n    match /top/{document=**} {\n      allow get: if true;\n    }\n  }\n}\n",
  cases: [
  {
    "description": "v1 glob after city does not match the city document",
    "expectation": "DENY",
    "method": "get",
    "path": "cities/SF",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "v1 glob after city matches a subcollection document",
    "expectation": "ALLOW",
    "method": "get",
    "path": "cities/SF/landmarks/x",
    "requestTime": "2026-01-01T00:00:00Z"
  },
  {
    "description": "v1 glob under a collection matches its document",
    "expectation": "ALLOW",
    "method": "get",
    "path": "top/a",
    "requestTime": "2026-01-01T00:00:00Z"
  }
],
};
