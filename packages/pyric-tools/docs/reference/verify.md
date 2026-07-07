# Verify API

`pyric-tools/verify` verifies captured sandbox sessions from code. It uses the
same fixture format and replay behavior as `pyric verify`.

## `verifyFixture(fixture, options)`

```ts
import { verifyFixture } from 'pyric-tools/verify';

const result = await verifyFixture(fixture, {
  rules: {
    firestore: firestoreRulesSource,
    rtdb: rtdbRulesDocumentOrJson,
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

`RtdbRulesDocument` values are compiled with `toJSON()` before replay.

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
};
```

Failing divergence kinds are `now-denied`, `state-drift`, and `unsupported`.
`expected-drift` is informational.

## Fixture helpers

```ts
import {
  buildVerifyFixture,
  parseVerifyFixture,
} from 'pyric-tools/verify';
```

`buildVerifyFixture()` is used by `pyric serve` capture. Most users read the
captured JSON from `.pyric/last-session.json`; custom harnesses can use the
builder to emit the same schema.
