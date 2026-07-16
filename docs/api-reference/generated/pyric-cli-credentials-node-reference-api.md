---
title: "API reference: @pyric/cli/credentials/node"
navLabel: "@pyric/cli/credentials/node"
outcome: "Published declarations for @pyric/cli/credentials/node."
slug: "pyric-cli-credentials-node-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/credentials/node"
apiSubpath: "credentials/node"
apiSymbolCount: 2
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Functions

<a id="fromadc"></a>

### fromAdc()

```ts
function fromAdc(
   projectId: string,
   env?: ProcessEnv,
path?: string): Promise<ProjectScope>;
```

Build a `ProjectScope` from ADC, or `null` if no ADC file is present. The
project is supplied by the caller — an ADC user credential isn't bound to one
(`--project` / `.firebaserc`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `projectId` | `string` |
| `env?` | `ProcessEnv` |
| `path?` | `string` |

#### Returns

`Promise`\<`ProjectScope`\>

***

<a id="fromserviceaccount"></a>

### fromServiceAccount()

```ts
function fromServiceAccount(saJsonOrPath: string): Promise<ProjectScope>;
```

Read the service account from a JSON file and return a
`ProjectScope` whose `resolveToken` is memoized internally.

The JSON file path can be:
- An absolute / relative filesystem path (Node only).
- A base64-encoded JSON string (when prefixed with `base64:`),
  for environments that ship the SA in an env var.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `saJsonOrPath` | `string` |

#### Returns

`Promise`\<`ProjectScope`\>
