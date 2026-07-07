# How to deploy Realtime Database rules

This guide shows you how to deploy a Realtime Database rules JSON file through
the Pyric CLI or through `pyric-tools/deploy`.

## Prepare the rules file

Put the complete RTDB rules JSON in a file such as `database.rules.json`:

```json
{
  "rules": {
    "profiles": {
      "$uid": {
        ".read": "auth.uid === $uid",
        ".write": "auth.uid === $uid"
      }
    }
  }
}
```

Add the file to `firebase.json`:

```json
{
  "database": {
    "rules": "database.rules.json"
  }
}
```

If the project has more than one RTDB instance, or instance discovery is not
available to the credential, include the URL:

```json
{
  "database": {
    "rules": "database.rules.json",
    "url": "https://demo-default-rtdb.firebaseio.com"
  }
}
```

## Check the rules locally

Run the linter:

```bash
pyric database:rules:lint database.rules.json
```

Run validation:

```bash
pyric database:rules:validate database.rules.json
```

To run a specific local simulation, pipe a request through stdin:

```bash
printf '%s\n' '{
  "rulesPath": "database.rules.json",
  "operation": "read",
  "path": "/profiles/alice",
  "auth": { "uid": "alice", "token": {} },
  "mockData": {}
}' | pyric database:rules:simulate --stdin
```

## Deploy from the CLI

Deploy with the URL from `firebase.json.database.url`:

```bash
pyric deploy database --project demo-project
```

To override the URL for one deploy:

```bash
pyric deploy database \
  --project demo-project \
  --database-url https://demo-default-rtdb.firebaseio.com
```

In CI, set `FIREBASE_DATABASE_URL` instead of adding the URL to
`firebase.json`:

```bash
FIREBASE_DATABASE_URL=https://demo-default-rtdb.firebaseio.com \
  pyric deploy database --project demo-project
```

When no URL is supplied, Pyric attempts to discover the single default RTDB
instance for the project. If discovery finds multiple candidates, pass an
explicit URL.

## Deploy from code

Use the `rtdb.rules` namespace when you are writing your own deploy flow:

```ts
import { fromServiceAccount, rtdb } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
const rulesJson = {
  rules: {
    profiles: {
      '$uid': {
        '.read': 'auth.uid === $uid',
        '.write': 'auth.uid === $uid',
      },
    },
  },
};

await rtdb.rules.deploy(scope, {
  rulesJson,
  databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
});
```

## Register the deploy tools with an agent

When the caller uses `@inbrowser/agent`, register the RTDB deploy factory next
to the other deploy factories:

```ts
import { createToolRegistry } from '@inbrowser/agent';
import {
  createFirestoreDeployTools,
  createRtdbDeployTools,
  createHostingDeployTools,
} from 'pyric-tools/deploy';

const registry = createToolRegistry();
const deps = { scope };

for (const tool of createFirestoreDeployTools(deps)) registry.register(tool);
for (const tool of createRtdbDeployTools(deps)) registry.register(tool);
for (const tool of createHostingDeployTools(deps)) registry.register(tool);
```

The RTDB deploy factory exposes `rtdb_get_rules` and `rtdb_deploy_rules`.

## Where to look next

- For exact function signatures, see [`rtdb` namespace](../reference/rtdb-namespace.md).
- For deploy tool schemas, see [Tool factories](../reference/tool-factories.md).
- For building a `ProjectScope`, see [Build a `ProjectScope` from a service account](./build-projectscope-from-service-account.md).
