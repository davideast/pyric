---
title: "rtdb namespace"
group: "pyric-tools / deploy"
section: "Reference"
order: 68
---
# `rtdb` namespace

Realtime Database rules deploy primitives.
```ts
import { rtdb } from 'pyric-tools/deploy';
```
The namespace works with Firebase RTDB rules JSON:
```ts
const rulesJson = {
  rules: {
    messages: {
      '$messageId': {
        '.read': 'auth !== null',
        '.write': 'auth !== null',
      },
    },
  },
};
```
## `rtdb.rules`

### `fetch(scope, input?): Promise<RtdbIR>`

Fetch the deployed RTDB rules and return Pyric's RTDB rule IR.
```ts
const ir = await rtdb.rules.fetch(scope, {
  databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
});
```
`input.databaseUrl` is optional. When omitted, the function attempts default
instance discovery.

### `deploy(scope, input): Promise<void>`

Deploy a complete RTDB rules JSON document or an RTDB rules document created by
`defineRtdbRules()`.
```ts
await rtdb.rules.deploy(scope, {
  rulesJson,
  databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
});
``````ts
await rtdb.rules.deploy(scope, {
  rules,
  databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
});
```
`rulesJson` must contain a top-level `rules` object. When `rules` is supplied,
the function calls `rules.toJSON()`. The function maps the JSON through
`RtdbMapper.mapToIR` before writing it to the RTDB rules endpoint.

### `discoverDefaultDatabaseUrl(scope): Promise<RtdbRulesDiscoveryResult>`

List RTDB instances for the project through the RTDB management API and return
the single default URL when it can be determined.
```ts
type RtdbRulesDiscoveryResult = {
  databaseUrl: string | null;
  candidates: string[];
};
```
`databaseUrl` is `null` when no instances are found or when multiple candidates
exist and no single default can be selected.

### `resolveDatabaseUrl(scope, explicitDatabaseUrl?): Promise<string>`

Return `explicitDatabaseUrl` when supplied. Otherwise, call
`discoverDefaultDatabaseUrl(scope)` and return the discovered default URL.

Throws when no URL can be resolved.

## Input types

### `RtdbDeployRulesInput`
```ts
type RtdbDeployRulesInput =
  | { rulesJson: unknown; databaseUrl?: string }
  | { rules: RtdbRulesDocument; databaseUrl?: string };
```
### `RtdbFetchRulesInput`
```ts
interface RtdbFetchRulesInput {
  databaseUrl?: string;
}
```
## Tool factory

`createRtdbDeployTools({ scope })` returns two deploy handlers.

| Tool | Parameters | Result data |
|---|---|---|
| `rtdb_get_rules` | `{ databaseUrl?: string }` | `{ ir: RtdbIR }` |
| `rtdb_deploy_rules` | `{ rulesJson: object; databaseUrl?: string }` | `undefined` |

The handler names match the host-backed RTDB rules tools from
`pyric/rules/rtdb`. Do not register both factories in the same registry unless
the registry supports explicit replacement.

Tool calls remain JSON-only. Pass `rules.toJSON()` as `rulesJson` when deploying
a generated rules document through an agent registry.

## CLI config shape

`pyric deploy database` reads:
```json
{
  "database": {
    "rules": "database.rules.json",
    "url": "https://demo-default-rtdb.firebaseio.com"
  }
}
```
`database.rules` is required. `database.url` is optional.

URL precedence:

1. `--database-url`
2. `FIREBASE_DATABASE_URL`
3. `firebase.json.database.url`
4. Default instance discovery

## OAuth scope

RTDB rules deploys require:
```ts
SCOPES.firebaseDatabase
```
The scope string is:
```text
https://www.googleapis.com/auth/firebase.database
```
It is not part of `BASE_SCOPES`; login-based credentials request it only when a
database deploy needs it.
