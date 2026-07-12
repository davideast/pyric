# Why RTDB rules authoring and deployment are separate

Pyric owns the rules-authoring loop: build a constraints document, compile it
to Firebase RTDB rules JSON, lint it, simulate it, and verify captured
sessions. None of that requires production write access.

```ts
import { rtdbRules } from 'pyric/rules';
import { rules } from './database.rules.js';

const rulesJson = rtdbRules(rules).toJSON();
```

The CLI writes the same artifact for inspection and source control:

```sh
pyric database rules generate --out database.rules.json
pyric database rules lint database.rules.json
pyric verify --service database --rules database=database.rules.json
```

Production deployment is a separate Firebase CLI step:

```sh
firebase deploy --only database
```

This boundary keeps authoring, analysis, and local verification usable in
tests and agent workflows while leaving project mutation and credential
ownership to Firebase's supported tooling.
