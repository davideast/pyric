---
title: "Verify API"
group: "pyric-tools"
section: "Reference"
order: 45
---
# Verify API

`pyric-tools/verify` verifies captured sandbox sessions from code. It uses the
same fixture format and replay behavior as `pyric verify`.

## `verifyFixture(fixture, options)`
```ts
import { verifyFixture } from 'pyric-tools/verify';

const result = await verifyFixture(fixture, {
  engines: ['sandbox', 'rulesTestApi'],
  services: ['firestore'],
  rules: {
    firestore: firestoreRulesSource,
    rtdb: rtdbRulesDocumentOrJson,
  },
  rulesTestApi: {
    scope,
    expressionReportLevel: 'VISITED',
  },
});
```
`fixture` must use schema `pyric.verify.fixture.v1`. The fixture has one
ordered `events` timeline and per-service blocks under `services`.
```ts
type VerifyRulesInput = {
  firestore?: string | { source: string };
  rtdb?: { rules: Record<string, unknown> } | RtdbRulesDocument;
  storage?: string | { source: string };
};
```
`RtdbRulesDocument` values are compiled to rules JSON before replay.
```ts
type VerifyEngine = 'sandbox' | 'rulesTestApi';

type VerifyFixtureOptions = {
  engines?: VerifyEngine[];
  services?: Array<'firestore' | 'rtdb'>;
  rules: VerifyRulesInput;
  rulesTestApi?: {
    scope: ProjectScope;
    expressionReportLevel?: 'NONE' | 'VISITED' | 'FULL';
  };
  caseDerivation?: {
    includeAllowed?: boolean;
    includeDenied?: boolean;
    mockReads?: 'strict' | 'omit';
  };
};
```
`engines` defaults to `['sandbox']`. `rulesTestApi` is Firestore-only in this
release. Selecting it for RTDB returns an input error.

## Result shape
```ts
type VerifyResult = {
  ok: boolean;
  services: {
    firestore?: VerifyServiceResult;
    rtdb?: VerifyServiceResult;
  };
};

type VerifyServiceResult = {
  service: 'firestore' | 'rtdb';
  ok: boolean;
  checkedEvents: number;
  divergences: VerifyDivergence[];
  engines?: Partial<Record<VerifyEngine, VerifyEngineResult>>;
};
```
Failing divergence kinds are `now-denied`, `now-allowed`, `state-drift`,
`unsupported`, and `engine-drift`. `expected-drift` is informational.

## `deriveRulesTestCases(fixture, options)`
```ts
import { deriveRulesTestCases } from 'pyric-tools/verify';

const cases = deriveRulesTestCases(fixture, {
  service: 'firestore',
  mockReads: 'strict',
});
```
This compiles captured Firestore request events into Firebase Rules Test API
`TestCase[]` values. Listener re-evaluations and admin/setup requests are
excluded. Unsupported derivation entries fail verification when the
`rulesTestApi` engine is selected.

## Fixture helpers
```ts
import {
  buildVerifyFixture,
  parseVerifyFixture,
} from 'pyric-tools/verify';
```
`buildVerifyFixture()` is used by `pyric dev` capture. Most users read the
captured JSON from `.pyric/last-session.json`; custom harnesses can use the
builder to emit the same schema.
