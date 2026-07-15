---
title: "API reference: @pyric/cli/verify"
navLabel: "@pyric/cli/verify"
outcome: "Published declarations for @pyric/cli/verify."
slug: "pyric-cli-verify-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/verify"
apiSubpath: "verify"
apiSymbolCount: 28
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="verifyinputerror"></a>

### VerifyInputError

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new VerifyInputError(message: string): VerifyInputError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message` | `string` |

###### Returns

[`VerifyInputError`](#verifyinputerror)

###### Overrides

```ts
Error.constructor
```

## Interfaces

<a id="buildverifyfixtureinput"></a>

### BuildVerifyFixtureInput

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="authstate"></a> `authState?` | \{ `currentUser?`: `unknown`; `users?`: `unknown`[]; \} | - |
| `authState.currentUser?` | `unknown` | - |
| `authState.users?` | `unknown`[] | - |
| <a id="capturedby"></a> `capturedBy?` | `string` | Stamped into the fixture as `capturedBy` (identity for boot-time event hydration). Omit for `pyric verify` builds — they have no instance. |
| <a id="createdat"></a> `createdAt?` | `string` | - |
| <a id="description"></a> `description?` | `string` | - |
| <a id="firestorerules"></a> `firestoreRules?` | `string` | - |
| <a id="rtdbdatabaseurl"></a> `rtdbDatabaseUrl?` | `string` | - |
| <a id="rtdbrules"></a> `rtdbRules?` | \{ `rules`: `Record`\<`string`, `unknown`\>; \} | - |
| `rtdbRules.rules` | `Record`\<`string`, `unknown`\> | - |
| <a id="rtdbstate"></a> `rtdbState?` | `unknown` | - |
| <a id="sandbox"></a> `sandbox` | `Pick`\<`Sandbox`, `"history"` \| `"snapshot"`\> & \{ `currentUser?`: `unknown`; \} | - |
| <a id="storagerules"></a> `storageRules?` | `string` | Currently-deployed storage rules text. RULES ONLY — there is no `storageState` input; captured storage OBJECTS are a separate, larger redesign left untouched by this fixture. |

***

<a id="derivedrulestestcase"></a>

### DerivedRulesTestCase

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="eventid"></a> `eventId` | `string` |
| <a id="testcase"></a> `testCase` | `TestCase` |

***

<a id="deriverulestestcasesoptions"></a>

### DeriveRulesTestCasesOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="includeallowed"></a> `includeAllowed?` | `boolean` |
| <a id="includedenied"></a> `includeDenied?` | `boolean` |
| <a id="mockreads"></a> `mockReads?` | `"strict"` \| `"omit"` |
| <a id="service"></a> `service?` | `"firestore"` |

***

<a id="deriverulestestcasesresult"></a>

### DeriveRulesTestCasesResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="derived"></a> `derived` | [`DerivedRulesTestCase`](#derivedrulestestcase)[] |
| <a id="ok"></a> `ok` | `boolean` |
| <a id="service-1"></a> `service` | `"firestore"` |
| <a id="testcases"></a> `testCases` | `TestCase`[] |
| <a id="unsupportedevents"></a> `unsupportedEvents` | [`VerifyUnsupportedEvent`](#verifyunsupportedevent)[] |
| <a id="warnings"></a> `warnings` | [`VerifyFixtureWarning`](#verifyfixturewarning)[] |

***

<a id="pyricverifyfixture"></a>

### PyricVerifyFixture

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="capturedby-1"></a> `capturedBy?` | `string` | Opaque id of the sandbox instance that produced this capture (the served SharedWorker's `instanceId`). Purely additive: `pyric verify` ignores it. Present only on captures written by the worker's capture flush; used by boot-time event hydration to SKIP priming a capture that belongs to a DIFFERENT instance (e.g. another browser profile sharing one `pyric dev`), so someone else's session never shows up as yours. Absent on older / standalone captures → hydration primes best-effort. |
| <a id="createdat-1"></a> `createdAt?` | `string` | - |
| <a id="description-1"></a> `description?` | `string` | - |
| <a id="events"></a> `events` | `SandboxEvent`[] | - |
| <a id="schema"></a> `schema` | `"pyric.verify.fixture.v1"` | - |
| <a id="services"></a> `services` | \{ \[`service`: `string`\]: `unknown`; `auth?`: \{ `state`: \{ `currentUser?`: `unknown`; `users?`: `unknown`[]; \}; \}; `firestore?`: \{ `rules`: [`VerifyFirestoreRulesBlock`](#verifyfirestorerulesblock); `state`: \{ `documents`: `Record`\<`string`, `Record`\<`string`, `unknown`\>\>; \}; \}; `rtdb?`: \{ `databaseUrl?`: `string`; `rules`: [`VerifyRtdbRulesBlock`](#verifyrtdbrulesblock); `state`: \{ `tree`: `unknown`; \}; \}; `storage?`: \{ `rules`: [`VerifyStorageRulesBlock`](#verifystoragerulesblock); `state`: `unknown`; \}; \} | - |
| `services.auth?` | \{ `state`: \{ `currentUser?`: `unknown`; `users?`: `unknown`[]; \}; \} | - |
| `services.auth.state` | \{ `currentUser?`: `unknown`; `users?`: `unknown`[]; \} | - |
| `services.auth.state.currentUser?` | `unknown` | - |
| `services.auth.state.users?` | `unknown`[] | - |
| `services.firestore?` | \{ `rules`: [`VerifyFirestoreRulesBlock`](#verifyfirestorerulesblock); `state`: \{ `documents`: `Record`\<`string`, `Record`\<`string`, `unknown`\>\>; \}; \} | - |
| `services.firestore.rules` | [`VerifyFirestoreRulesBlock`](#verifyfirestorerulesblock) | - |
| `services.firestore.state` | \{ `documents`: `Record`\<`string`, `Record`\<`string`, `unknown`\>\>; \} | - |
| `services.firestore.state.documents` | `Record`\<`string`, `Record`\<`string`, `unknown`\>\> | - |
| `services.rtdb?` | \{ `databaseUrl?`: `string`; `rules`: [`VerifyRtdbRulesBlock`](#verifyrtdbrulesblock); `state`: \{ `tree`: `unknown`; \}; \} | - |
| `services.rtdb.databaseUrl?` | `string` | - |
| `services.rtdb.rules` | [`VerifyRtdbRulesBlock`](#verifyrtdbrulesblock) | - |
| `services.rtdb.state` | \{ `tree`: `unknown`; \} | - |
| `services.rtdb.state.tree` | `unknown` | - |
| `services.storage?` | \{ `rules`: [`VerifyStorageRulesBlock`](#verifystoragerulesblock); `state`: `unknown`; \} | - |
| `services.storage.rules` | [`VerifyStorageRulesBlock`](#verifystoragerulesblock) | RULES TEXT ONLY — captured object state is a separate, larger redesign (persistence.ts's IDB blob store) and is deliberately left untouched here. `state` stays `null` until that lands. |
| `services.storage.state` | `unknown` | - |

***

<a id="verifyengineresult"></a>

### VerifyEngineResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="checkedevents"></a> `checkedEvents` | `number` |
| <a id="derivation"></a> `derivation?` | [`DeriveRulesTestCasesResult`](#deriverulestestcasesresult) |
| <a id="divergences"></a> `divergences` | [`VerifyDivergence`](#verifydivergence)[] |
| <a id="engine"></a> `engine` | [`VerifyEngine`](#verifyengine) |
| <a id="failed"></a> `failed?` | `number` |
| <a id="ok-1"></a> `ok` | `boolean` |
| <a id="passed"></a> `passed?` | `number` |
| <a id="results"></a> `results?` | `TestResult`[] |
| <a id="testcases-1"></a> `testCases?` | `number` |
| <a id="unsupported"></a> `unsupported?` | `number` |

***

<a id="verifyfirestorerulesblock"></a>

### VerifyFirestoreRulesBlock

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format"></a> `format` | `"firestore.rules"` |
| <a id="source"></a> `source` | `string` |

***

<a id="verifyfixtureoptions"></a>

### VerifyFixtureOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="casederivation"></a> `caseDerivation?` | `Omit`\<[`DeriveRulesTestCasesOptions`](#deriverulestestcasesoptions), `"service"`\> |
| <a id="engines"></a> `engines?` | [`VerifyEngine`](#verifyengine)[] |
| <a id="rules"></a> `rules` | [`VerifyRulesInput`](#verifyrulesinput) |
| <a id="rulestestapi"></a> `rulesTestApi?` | \{ `expressionReportLevel?`: `ExpressionReportLevel`; `scope`: `ProjectScope`; \} |
| `rulesTestApi.expressionReportLevel?` | `ExpressionReportLevel` |
| `rulesTestApi.scope` | `ProjectScope` |
| <a id="services-1"></a> `services?` | [`VerifiableService`](#verifiableservice)[] |

***

<a id="verifyresult"></a>

### VerifyResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="ok-2"></a> `ok` | `boolean` |
| <a id="services-2"></a> `services` | `Partial`\<`Record`\<[`VerifiableService`](#verifiableservice), [`VerifyServiceResult`](#verifyserviceresult)\>\> |

***

<a id="verifyrtdbrulesblock"></a>

### VerifyRtdbRulesBlock

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-1"></a> `format` | `"rtdb.rules.json"` |
| <a id="json"></a> `json` | \{ `rules`: `Record`\<`string`, `unknown`\>; \} |
| `json.rules` | `Record`\<`string`, `unknown`\> |

***

<a id="verifyserviceresult"></a>

### VerifyServiceResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="checkedevents-1"></a> `checkedEvents` | `number` |
| <a id="divergences-1"></a> `divergences` | [`VerifyDivergence`](#verifydivergence)[] |
| <a id="engines-1"></a> `engines?` | `Partial`\<`Record`\<[`VerifyEngine`](#verifyengine), [`VerifyEngineResult`](#verifyengineresult)\>\> |
| <a id="ok-3"></a> `ok` | `boolean` |
| <a id="service-2"></a> `service` | [`VerifiableService`](#verifiableservice) |

***

<a id="verifystoragerulesblock"></a>

### VerifyStorageRulesBlock

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-2"></a> `format` | `"storage.rules"` |
| <a id="source-1"></a> `source` | `string` |

***

<a id="verifytooldeps"></a>

### VerifyToolDeps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="scope"></a> `scope?` | `ProjectScope` |

## Type Aliases

<a id="verifiableservice"></a>

### VerifiableService

```ts
type VerifiableService = "firestore" | "rtdb";
```

***

<a id="verifydivergence"></a>

### VerifyDivergence

```ts
type VerifyDivergence =
  | {
  kind: "now-denied";
  method?: string;
  path?: string;
  reason?: string;
  service: EventService | string;
}
  | {
  kind: "now-allowed";
  method?: string;
  path?: string;
  reason?: string;
  service: EventService | string;
}
  | {
  after: unknown;
  before: unknown;
  field?: string;
  kind: "state-drift";
  path?: string;
  service: EventService | string;
}
  | {
  kind: "unsupported";
  method?: string;
  path?: string;
  reason: string;
  service: EventService | string;
}
  | {
  after?: unknown;
  before?: unknown;
  drift: string;
  field?: string;
  kind: "expected-drift";
  path?: string;
  service: EventService | string;
}
  | {
  kind: "engine-drift";
  method?: string;
  path?: string;
  reason?: string;
  rulesTestApi: string;
  sandbox: string;
  service: EventService | string;
};
```

***

<a id="verifyengine"></a>

### VerifyEngine

```ts
type VerifyEngine = "sandbox" | "rulesTestApi";
```

***

<a id="verifyfixturewarning"></a>

### VerifyFixtureWarning

```ts
type VerifyFixtureWarning = {
  code: string;
  eventId?: string;
  message: string;
  method?: string;
  path?: string;
  service: "firestore";
};
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="code"></a> `code` | `string` |
| <a id="eventid-1"></a> `eventId?` | `string` |
| <a id="message"></a> `message` | `string` |
| <a id="method"></a> `method?` | `string` |
| <a id="path"></a> `path?` | `string` |
| <a id="service-3"></a> `service` | `"firestore"` |

***

<a id="verifyrulesinput"></a>

### VerifyRulesInput

```ts
type VerifyRulesInput = {
  firestore?:   | string
     | {
     source: string;
   };
  rtdb?:   | {
     rules: Record<string, unknown>;
   }
     | RtdbRulesDocument;
  storage?:   | string
     | {
     source: string;
   };
};
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="firestore"></a> `firestore?` | \| `string` \| \{ `source`: `string`; \} |
| <a id="rtdb"></a> `rtdb?` | \| \{ `rules`: `Record`\<`string`, `unknown`\>; \} \| `RtdbRulesDocument` |
| <a id="storage"></a> `storage?` | \| `string` \| \{ `source`: `string`; \} |

***

<a id="verifyunsupportedevent"></a>

### VerifyUnsupportedEvent

```ts
type VerifyUnsupportedEvent = {
  eventId?: string;
  method?: string;
  path?: string;
  reason: string;
  service: "firestore";
};
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="eventid-2"></a> `eventId?` | `string` |
| <a id="method-1"></a> `method?` | `string` |
| <a id="path-1"></a> `path?` | `string` |
| <a id="reason"></a> `reason` | `string` |
| <a id="service-4"></a> `service` | `"firestore"` |

## Variables

<a id="verify_fixture_schema"></a>

### VERIFY\_FIXTURE\_SCHEMA

```ts
const VERIFY_FIXTURE_SCHEMA: "pyric.verify.fixture.v1";
```

## Functions

<a id="buildverifyfixture"></a>

### buildVerifyFixture()

```ts
function buildVerifyFixture(input: BuildVerifyFixtureInput): PyricVerifyFixture;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | [`BuildVerifyFixtureInput`](#buildverifyfixtureinput) |

#### Returns

[`PyricVerifyFixture`](#pyricverifyfixture)

***

<a id="createverifytools"></a>

### createVerifyTools()

```ts
function createVerifyTools(deps?: VerifyToolDeps): ToolHandler<unknown, unknown>[];
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `deps?` | [`VerifyToolDeps`](#verifytooldeps) |

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

<a id="deriverulestestcases"></a>

### deriveRulesTestCases()

```ts
function deriveRulesTestCases(fixtureInput: unknown, opts?: DeriveRulesTestCasesOptions): DeriveRulesTestCasesResult;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `fixtureInput` | `unknown` |
| `opts?` | [`DeriveRulesTestCasesOptions`](#deriverulestestcasesoptions) |

#### Returns

[`DeriveRulesTestCasesResult`](#deriverulestestcasesresult)

***

<a id="fixtureverifiableservices"></a>

### fixtureVerifiableServices()

```ts
function fixtureVerifiableServices(fixture: PyricVerifyFixture): ("firestore" | "rtdb")[];
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `fixture` | [`PyricVerifyFixture`](#pyricverifyfixture) |

#### Returns

(`"firestore"` \| `"rtdb"`)[]

***

<a id="parseverifyfixture"></a>

### parseVerifyFixture()

```ts
function parseVerifyFixture(value: unknown): PyricVerifyFixture;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

[`PyricVerifyFixture`](#pyricverifyfixture)

***

<a id="restorestoragerulesfromfixture"></a>

### restoreStorageRulesFromFixture()

```ts
function restoreStorageRulesFromFixture(fixture: PyricVerifyFixture, sandbox: Sandbox): void;
```

Re-deploy a fixture's captured storage rules into a sandbox's storage
evaluator. RULES TEXT ONLY, mirroring the capture-side scope note: this
never touches storage OBJECTS (persistence.ts's IDB blob store) — only
`fixture.services.storage.rules.source` is applied.

Storage rules are honored only on the FIRST `getStorageSandbox` call per
`Sandbox` (see `storage/service.ts`), so this must run before any other
code opens the storage service on `sandbox` — exactly the same ordering
constraint firestore/rtdb rules already have at restore time. A no-op
when the fixture carries no storage block.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `fixture` | [`PyricVerifyFixture`](#pyricverifyfixture) |
| `sandbox` | `Sandbox` |

#### Returns

`void`

***

<a id="verifyfixture"></a>

### verifyFixture()

```ts
function verifyFixture(fixtureInput: unknown, opts: VerifyFixtureOptions): Promise<VerifyResult>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `fixtureInput` | `unknown` |
| `opts` | [`VerifyFixtureOptions`](#verifyfixtureoptions) |

#### Returns

`Promise`\<[`VerifyResult`](#verifyresult)\>
