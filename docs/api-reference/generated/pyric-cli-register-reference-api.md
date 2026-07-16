---
title: "API reference: @pyric/cli/register"
navLabel: "@pyric/cli/register"
outcome: "Published declarations for @pyric/cli/register."
slug: "pyric-cli-register-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/register"
apiSubpath: "register"
apiSymbolCount: 1
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Variables

<a id="active"></a>

### active

```ts
active: boolean;
```

Whether this process's firebase-admin/firebase imports are being rewritten
 to the pyric sandbox — true only when `PYRIC_SANDBOX` was set (and not
 refused by the production guard) at the moment this module loaded.
