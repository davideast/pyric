---
title: "API reference: @pyric/cli/assurance"
navLabel: "@pyric/cli/assurance"
group: "API reference"
section: "@pyric/cli"
order: 24013
description: "Published declarations for @pyric/cli/assurance."
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/assurance"
apiSubpath: "assurance"
apiSymbolCount: 67
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="assurancecampaignstore"></a>

### AssuranceCampaignStore

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new AssuranceCampaignStore(): AssuranceCampaignStore;
```

###### Returns

[`AssuranceCampaignStore`](#assurancecampaignstore)

#### Methods

<a id="create"></a>

##### create()

```ts
create(campaign: AuthorizationCampaign): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `campaign` | [`AuthorizationCampaign`](#authorizationcampaign) |

###### Returns

`void`

<a id="get"></a>

##### get()

```ts
get(id: string): AuthorizationCampaign;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `id` | `string` |

###### Returns

[`AuthorizationCampaign`](#authorizationcampaign)

<a id="publish"></a>

##### publish()

```ts
publish(campaign: AuthorizationCampaign): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `campaign` | [`AuthorizationCampaign`](#authorizationcampaign) |

###### Returns

`void`

<a id="subscribe"></a>

##### subscribe()

```ts
subscribe(listener: (campaign: AssuranceVisualizationSnapshot) => void): () => void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `listener` | (`campaign`: [`AssuranceVisualizationSnapshot`](#assurancevisualizationsnapshot)) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

***

<a id="assuranceinputerror"></a>

### AssuranceInputError

#### Extends

- `Error`

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new AssuranceInputError(message?: string): AssuranceInputError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message?` | `string` |

###### Returns

[`AssuranceInputError`](#assuranceinputerror)

###### Inherited from

```ts
Error.constructor
```

##### Constructor

```ts
new AssuranceInputError(message?: string, options?: ErrorOptions): AssuranceInputError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message?` | `string` |
| `options?` | `ErrorOptions` |

###### Returns

[`AssuranceInputError`](#assuranceinputerror)

###### Inherited from

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Default value |
| :------ | :------ | :------ | :------ |
| <a id="code"></a> `code` | `readonly` | `"ASSURANCE_INVALID_INPUT"` | `"ASSURANCE_INVALID_INPUT"` |

***

<a id="authorizationcampaign"></a>

### AuthorizationCampaign

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new AuthorizationCampaign(options: CreateAuthorizationCampaignOptions): AuthorizationCampaign;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`CreateAuthorizationCampaignOptions`](#createauthorizationcampaignoptions) |

###### Returns

[`AuthorizationCampaign`](#authorizationcampaign)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="context"></a> `context` | `readonly` | [`AssuranceCampaignContext`](#assurancecampaigncontext) |
| <a id="id"></a> `id` | `readonly` | `string` |
| <a id="maxruns"></a> `maxRuns` | `readonly` | `number` |
| <a id="target"></a> `target` | `readonly` | [`LocalFirebaseTarget`](#localfirebasetarget) |

#### Accessors

<a id="observations"></a>

##### observations

###### Get Signature

```ts
get observations(): AssuranceObservation[];
```

###### Returns

[`AssuranceObservation`](#assuranceobservation)[]

<a id="report"></a>

##### report

###### Get Signature

```ts
get report(): AuthorizationCampaignReport;
```

###### Returns

[`AuthorizationCampaignReport`](#authorizationcampaignreport-1)

#### Methods

<a id="addactor"></a>

##### addActor()

```ts
addActor(actor: AssuranceActor): AssuranceActor;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `actor` | [`AssuranceActor`](#assuranceactor) |

###### Returns

[`AssuranceActor`](#assuranceactor)

<a id="addinvariant"></a>

##### addInvariant()

```ts
addInvariant(invariant: SecurityInvariant): SecurityInvariant;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `invariant` | [`SecurityInvariant`](#securityinvariant) |

###### Returns

[`SecurityInvariant`](#securityinvariant)

<a id="addobservation"></a>

##### addObservation()

```ts
addObservation(observation: AssuranceObservation): AssuranceObservation;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `observation` | [`AssuranceObservation`](#assuranceobservation) |

###### Returns

[`AssuranceObservation`](#assuranceobservation)

<a id="addprobe"></a>

##### addProbe()

```ts
addProbe(probe: AssuranceProbe): AssuranceProbe;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `probe` | [`AssuranceProbe`](#assuranceprobe) |

###### Returns

[`AssuranceProbe`](#assuranceprobe)

<a id="export"></a>

##### export()

```ts
export(): CampaignExport;
```

###### Returns

[`CampaignExport`](#campaignexport)

<a id="exportsecuritycases"></a>

##### exportSecurityCases()

```ts
exportSecurityCases(options?: {
  includeCandidates?: boolean;
}): SecurityCase[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | \{ `includeCandidates?`: `boolean`; \} |
| `options.includeCandidates?` | `boolean` |

###### Returns

[`SecurityCase`](#securitycase)[]

<a id="inspect"></a>

##### inspect()

```ts
inspect(probeId: string): AssuranceProbeResult;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `probeId` | `string` |

###### Returns

[`AssuranceProbeResult`](#assuranceproberesult)

<a id="minimize"></a>

##### minimize()

```ts
minimize(probeId: string): Promise<MinimizationResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `probeId` | `string` |

###### Returns

`Promise`\<[`MinimizationResult`](#minimizationresult)\>

<a id="propose"></a>

##### propose()

```ts
propose(input: ProposalInput): AssuranceProbe[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | [`ProposalInput`](#proposalinput) |

###### Returns

[`AssuranceProbe`](#assuranceprobe)[]

<a id="run"></a>

##### run()

```ts
run(probeIds?: string[]): Promise<AuthorizationCampaignReport>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `probeIds?` | `string`[] |

###### Returns

`Promise`\<[`AuthorizationCampaignReport`](#authorizationcampaignreport-1)\>

<a id="spec"></a>

##### spec()

```ts
spec(probeIds?: string[]): AuthorizationCampaignSpec;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `probeIds?` | `string`[] |

###### Returns

[`AuthorizationCampaignSpec`](#authorizationcampaignspec-2)

<a id="verifyrules"></a>

##### verifyRules()

```ts
verifyRules(options: {
  id?: string;
  includeCandidates?: boolean;
  rules: {
     firestore?: string;
     rtdb?: {
        rules: Record<string, unknown>;
     };
     storage?: string;
  };
}): Promise<AuthorizationCampaignReport>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | \{ `id?`: `string`; `includeCandidates?`: `boolean`; `rules`: \{ `firestore?`: `string`; `rtdb?`: \{ `rules`: `Record`\<`string`, `unknown`\>; \}; `storage?`: `string`; \}; \} |
| `options.id?` | `string` |
| `options.includeCandidates?` | `boolean` |
| `options.rules` | \{ `firestore?`: `string`; `rtdb?`: \{ `rules`: `Record`\<`string`, `unknown`\>; \}; `storage?`: `string`; \} |
| `options.rules.firestore?` | `string` |
| `options.rules.rtdb?` | \{ `rules`: `Record`\<`string`, `unknown`\>; \} |
| `options.rules.rtdb.rules` | `Record`\<`string`, `unknown`\> |
| `options.rules.storage?` | `string` |

###### Returns

`Promise`\<[`AuthorizationCampaignReport`](#authorizationcampaignreport-1)\>

<a id="visualization"></a>

##### visualization()

```ts
visualization(): AssuranceVisualizationSnapshot;
```

###### Returns

[`AssuranceVisualizationSnapshot`](#assurancevisualizationsnapshot)

## Interfaces

<a id="actorevidence"></a>

### ActorEvidence

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="acquisition"></a> `acquisition` | \| `"anonymous-request"` \| `"anonymous-account"` \| `"password"` \| `"fixture-user"` \| `"synthetic"` |
| <a id="actorid"></a> `actorId` | `string` |
| <a id="error"></a> `error?` | `string` |
| <a id="reachability"></a> `reachability` | `"synthetic"` \| `"reachable"` \| `"unreachable"` |
| <a id="uid"></a> `uid?` | `string` |

***

<a id="assuranceactor"></a>

### AssuranceActor

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="acquisition-1"></a> `acquisition` | [`ActorAcquisition`](#actoracquisition) |
| <a id="id-1"></a> `id` | `string` |

***

<a id="assuranceattachment"></a>

### AssuranceAttachment

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="coveragegaps"></a> `coverageGaps` | [`AssuranceCoverageGap`](#assurancecoveragegap)[] |
| <a id="inventory"></a> `inventory` | [`AssuranceAttachmentInventory`](#assuranceattachmentinventory-1) |
| <a id="source"></a> `source` | [`AssuranceAttachmentSource`](#assuranceattachmentsource-1) |
| <a id="target-1"></a> `target` | [`LocalFirebaseTarget`](#localfirebasetarget) |

***

<a id="assuranceattachmentinput"></a>

### AssuranceAttachmentInput

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="url"></a> `url` | `string` |

***

<a id="assuranceattachmentinventory-1"></a>

### AssuranceAttachmentInventory

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="authusers"></a> `authUsers` | `number` |
| <a id="firestoredocuments"></a> `firestoreDocuments` | `number` |
| <a id="rtdbpresent"></a> `rtdbPresent` | `boolean` |
| <a id="storageobjects"></a> `storageObjects` | `number` |

***

<a id="assuranceattachmentsource-1"></a>

### AssuranceAttachmentSource

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="origin"></a> `origin` | `string` |
| <a id="readonly"></a> `readOnly` | `true` |
| <a id="requestedurl"></a> `requestedUrl` | `string` |
| <a id="studiourl"></a> `studioUrl` | `string` |
| <a id="transport"></a> `transport` | `"same-origin-shared-worker"` |

***

<a id="assurancecampaigncontext"></a>

### AssuranceCampaignContext

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="attachment"></a> `attachment?` | \{ `coverageGaps`: [`AssuranceCoverageGap`](#assurancecoveragegap)[]; `inventory`: [`AssuranceAttachmentInventory`](#assuranceattachmentinventory-1); `source`: [`AssuranceAttachmentSource`](#assuranceattachmentsource-1); \} |
| `attachment.coverageGaps` | [`AssuranceCoverageGap`](#assurancecoveragegap)[] |
| `attachment.inventory` | [`AssuranceAttachmentInventory`](#assuranceattachmentinventory-1) |
| `attachment.source` | [`AssuranceAttachmentSource`](#assuranceattachmentsource-1) |

***

<a id="assurancecoveragegap"></a>

### AssuranceCoverageGap

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="code-1"></a> `code` | `string` |
| <a id="reason"></a> `reason` | `string` |
| <a id="service"></a> `service` | `"auth"` \| [`AssuranceService`](#assuranceservice) \| `"attachment"` |

***

<a id="assuranceeventevidence"></a>

### AssuranceEventEvidence

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="actor"></a> `actor?` | `unknown` |
| <a id="at"></a> `at?` | `number` |
| <a id="auth"></a> `auth?` | `unknown` |
| <a id="authlens"></a> `authLens?` | `unknown` |
| <a id="evaluatedrule"></a> `evaluatedRule?` | `unknown` |
| <a id="id-2"></a> `id?` | `string` |
| <a id="kind"></a> `kind?` | `string` |
| <a id="matchedrule"></a> `matchedRule?` | `unknown` |
| <a id="method"></a> `method?` | `string` |
| <a id="op"></a> `op?` | `string` |
| <a id="origin-1"></a> `origin?` | `unknown` |
| <a id="path"></a> `path?` | `string` |
| <a id="reasons"></a> `reasons?` | `string`[] |
| <a id="request"></a> `request?` | `unknown` |
| <a id="resourcebefore"></a> `resourceBefore?` | `unknown` |
| <a id="result"></a> `result?` | `string` |
| <a id="rules"></a> `rules?` | `unknown` |
| <a id="service-1"></a> `service?` | `string` |

***

<a id="assuranceobservation"></a>

### AssuranceObservation

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="actorid-1"></a> `actorId` | `string` |
| <a id="description"></a> `description?` | `string` |
| <a id="id-3"></a> `id` | `string` |
| <a id="operation"></a> `operation` | [`FirebaseOperation`](#firebaseoperation) |
| <a id="result-1"></a> `result` | `"ALLOW"` |
| <a id="source-1"></a> `source` | `"captured"` \| `"authored"` \| `"discovered"` |

***

<a id="assuranceprobe"></a>

### AssuranceProbe

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="actorid-2"></a> `actorId` | `string` | - |
| <a id="control"></a> `control` | [`FirebaseOperation`](#firebaseoperation) | - |
| <a id="id-4"></a> `id` | `string` | - |
| <a id="invariantid"></a> `invariantId` | `string` | - |
| <a id="mutation"></a> `mutation` | [`ProbeMutation`](#probemutation) | - |
| <a id="requires"></a> `requires?` | `CapabilityDependency`[] | Graph nodes this probe's verdict depends on. Each is resolved live against the conformance graph statuses: a node the graph derives non-`supported` makes the engine abstain (engine-gap), and a node the graph does not model is a campaign authoring error (invalid-probe). |

***

<a id="assuranceproberesult"></a>

### AssuranceProbeResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="actorevidence-1"></a> `actorEvidence` | [`ActorEvidence`](#actorevidence) |
| <a id="campaignid"></a> `campaignId` | `string` |
| <a id="classification"></a> `classification` | [`ProbeClassification`](#probeclassification) |
| <a id="control-1"></a> `control` | [`OperationEvidence`](#operationevidence) |
| <a id="invariant"></a> `invariant` | [`SecurityInvariant`](#securityinvariant) |
| <a id="mutation-1"></a> `mutation` | [`OperationEvidence`](#operationevidence) |
| <a id="mutationspec"></a> `mutationSpec` | [`ProbeMutation`](#probemutation) |
| <a id="probeid"></a> `probeId` | `string` |
| <a id="qualification"></a> `qualification` | [`EngineQualification`](#enginequalification) |
| <a id="statediff"></a> `stateDiff?` | [`StateDiff`](#statediff-1) |
| <a id="targethash"></a> `targetHash` | `string` |

***

<a id="assurancereportsummary"></a>

### AssuranceReportSummary

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="candidatesignals"></a> `candidateSignals` | `number` |
| <a id="controlspassed"></a> `controlsPassed` | `number` |
| <a id="enginegaps"></a> `engineGaps` | `number` |
| <a id="invalidprobes"></a> `invalidProbes` | `number` |
| <a id="localcounterexamples"></a> `localCounterexamples` | `number` |
| <a id="nocounterexamples"></a> `noCounterexamples` | `number` |
| <a id="probes"></a> `probes` | `number` |

***

<a id="assurancetooldeps"></a>

### AssuranceToolDeps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="attachmentprovider"></a> `attachmentProvider?` | [`AssuranceAttachmentProvider`](#assuranceattachmentprovider) |
| <a id="oncampaignupdate"></a> `onCampaignUpdate?` | (`campaign`: [`AssuranceVisualizationSnapshot`](#assurancevisualizationsnapshot)) => `void` |
| <a id="store"></a> `store?` | [`AssuranceCampaignStore`](#assurancecampaignstore) |

***

<a id="assurancevisualizationsnapshot"></a>

### AssuranceVisualizationSnapshot

Credential-free projection safe to hand to Studio visualization code.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="campaignid-1"></a> `campaignId` | `string` |
| <a id="context-1"></a> `context?` | [`AssuranceCampaignContext`](#assurancecampaigncontext) |
| <a id="observations-1"></a> `observations` | [`AssuranceObservation`](#assuranceobservation)[] |
| <a id="probes-1"></a> `probes` | [`AssuranceProbe`](#assuranceprobe)[] |
| <a id="report-1"></a> `report?` | [`AuthorizationCampaignReport`](#authorizationcampaignreport-1) |
| <a id="schema"></a> `schema` | `"pyric.assurance.visualization.v1"` |
| <a id="verifications"></a> `verifications?` | [`AuthorizationCampaignReport`](#authorizationcampaignreport-1)[] |

***

<a id="authfixtureuser"></a>

### AuthFixtureUser

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="customclaims"></a> `customClaims?` | `Record`\<`string`, `unknown`\> |
| <a id="disabled"></a> `disabled?` | `boolean` |
| <a id="email"></a> `email?` | `string` |
| <a id="emailverified"></a> `emailVerified?` | `boolean` |
| <a id="password"></a> `password?` | `string` |
| <a id="uid-1"></a> `uid` | `string` |

***

<a id="authorizationcampaignreport-1"></a>

### AuthorizationCampaignReport

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="campaignid-2"></a> `campaignId` | `string` |
| <a id="localonly"></a> `localOnly` | \{ `engine`: `"pyric-local-sandboxes"`; `network`: `"forbid"`; \} |
| `localOnly.engine` | `"pyric-local-sandboxes"` |
| `localOnly.network` | `"forbid"` |
| <a id="results"></a> `results` | [`AssuranceProbeResult`](#assuranceproberesult)[] |
| <a id="schema-1"></a> `schema` | `"pyric.assurance.report.v1"` |
| <a id="summary"></a> `summary` | [`AssuranceReportSummary`](#assurancereportsummary) |
| <a id="targethash-1"></a> `targetHash` | `string` |

***

<a id="authorizationcampaignspec-2"></a>

### AuthorizationCampaignSpec

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="actors"></a> `actors` | [`AssuranceActor`](#assuranceactor)[] |
| <a id="id-5"></a> `id` | `string` |
| <a id="invariants"></a> `invariants` | [`SecurityInvariant`](#securityinvariant)[] |
| <a id="probes-2"></a> `probes` | [`AssuranceProbe`](#assuranceprobe)[] |
| <a id="schema-2"></a> `schema` | `"pyric.assurance.campaign.v1"` |
| <a id="target-2"></a> `target` | [`LocalFirebaseTarget`](#localfirebasetarget) |

***

<a id="campaignexport"></a>

### CampaignExport

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="campaign"></a> `campaign` | [`AuthorizationCampaignSpec`](#authorizationcampaignspec-2) |
| <a id="cases"></a> `cases` | [`SecurityCase`](#securitycase)[] |
| <a id="context-2"></a> `context?` | [`AssuranceCampaignContext`](#assurancecampaigncontext) |
| <a id="observations-2"></a> `observations` | [`AssuranceObservation`](#assuranceobservation)[] |
| <a id="report-2"></a> `report?` | [`AuthorizationCampaignReport`](#authorizationcampaignreport-1) |
| <a id="schema-3"></a> `schema` | `"pyric.assurance.export.v1"` |
| <a id="verifications-1"></a> `verifications?` | [`AuthorizationCampaignReport`](#authorizationcampaignreport-1)[] |

***

<a id="capabilityrequirement"></a>

### CapabilityRequirement

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="id-6"></a> `id` | `string` |
| <a id="reason-1"></a> `reason` | `string` |
| <a id="supported"></a> `supported` | `boolean` |

***

<a id="createauthorizationcampaignoptions"></a>

### CreateAuthorizationCampaignOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="context-3"></a> `context?` | [`AssuranceCampaignContext`](#assurancecampaigncontext) |
| <a id="id-7"></a> `id` | `string` |
| <a id="safety"></a> `safety?` | \{ `maxRuns?`: `number`; `network?`: `"forbid"`; \} |
| `safety.maxRuns?` | `number` |
| `safety.network?` | `"forbid"` |
| <a id="target-3"></a> `target` | [`LocalFirebaseTarget`](#localfirebasetarget) |

***

<a id="enginequalification"></a>

### EngineQualification

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classification-1"></a> `classification?` | `"engine-gap"` \| `"invalid-probe"` | How an unsupported qualification must be classified. Absent when the qualification is supported. `engine-gap` is the default abstention (a target-specific check failed, or a declared capability is derived non-supported); `invalid-probe` overrides it when the campaign declared a capability the engine does not define. |
| <a id="engine"></a> `engine` | `"pyric-local-sandboxes"` | - |
| <a id="requirements"></a> `requirements` | [`CapabilityRequirement`](#capabilityrequirement)[] | - |
| <a id="supported-1"></a> `supported` | `boolean` | - |

***

<a id="firestoreoperation"></a>

### FirestoreOperation

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data?` | `Record`\<`string`, `unknown`\> |
| <a id="method-1"></a> `method` | `"get"` \| `"list"` \| `"create"` \| `"set"` \| `"merge"` \| `"update"` \| `"delete"` |
| <a id="path-1"></a> `path` | `string` |
| <a id="query"></a> `query?` | \{ `limit?`: `number`; `orderBy?`: \{ `direction?`: `"asc"` \| `"desc"`; `field`: `string`; \}[]; `where?`: [`FirestoreQueryConstraint`](#firestorequeryconstraint)[]; \} |
| `query.limit?` | `number` |
| `query.orderBy?` | \{ `direction?`: `"asc"` \| `"desc"`; `field`: `string`; \}[] |
| `query.where?` | [`FirestoreQueryConstraint`](#firestorequeryconstraint)[] |
| <a id="service-2"></a> `service` | `"firestore"` |

***

<a id="firestorequeryconstraint"></a>

### FirestoreQueryConstraint

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="field"></a> `field` | `string` |
| <a id="op-1"></a> `op` | \| `"<"` \| `"<="` \| `"=="` \| `"!="` \| `">="` \| `">"` \| `"array-contains"` \| `"in"` \| `"not-in"` \| `"array-contains-any"` |
| <a id="value"></a> `value` | `unknown` |

***

<a id="generatedassurancecapability"></a>

### GeneratedAssuranceCapability

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="dependencies"></a> `dependencies` | `GeneratedCapabilityDependency`[] | Everything the status rests on. The ones that pinned it are the ones whose verdict equals the status; `capabilityReasons` selects and renders them. |
| <a id="description-1"></a> `description` | `string` | - |
| <a id="id-8"></a> `id` | `string` | - |
| <a id="service-3"></a> `service` | `AssuranceCapabilityService` | - |
| <a id="status"></a> `status` | `AssuranceCapabilityStatus` | - |

***

<a id="localfirebasetarget"></a>

### LocalFirebaseTarget

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="network"></a> `network` | `"forbid"` |
| <a id="rules-1"></a> `rules` | \{ `firestore?`: `string`; `rtdb?`: \{ `rules`: `Record`\<`string`, `unknown`\>; \}; `storage?`: `string`; \} |
| `rules.firestore?` | `string` |
| `rules.rtdb?` | \{ `rules`: `Record`\<`string`, `unknown`\>; \} |
| `rules.rtdb.rules` | `Record`\<`string`, `unknown`\> |
| `rules.storage?` | `string` |
| <a id="schema-4"></a> `schema` | `"pyric.assurance.target.v1"` |
| <a id="state"></a> `state` | \{ `auth?`: \{ `users`: [`AuthFixtureUser`](#authfixtureuser)[]; \}; `firestore?`: `Record`\<`string`, `Record`\<`string`, `unknown`\>\>; `rtdb?`: `unknown`; `storage?`: [`StorageObjectFixture`](#storageobjectfixture)[]; \} |
| `state.auth?` | \{ `users`: [`AuthFixtureUser`](#authfixtureuser)[]; \} |
| `state.auth.users` | [`AuthFixtureUser`](#authfixtureuser)[] |
| `state.firestore?` | `Record`\<`string`, `Record`\<`string`, `unknown`\>\> |
| `state.rtdb?` | `unknown` |
| `state.storage?` | [`StorageObjectFixture`](#storageobjectfixture)[] |

***

<a id="minimizationresult"></a>

### MinimizationResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="changed"></a> `changed` | `boolean` |
| <a id="probe"></a> `probe` | [`AssuranceProbe`](#assuranceprobe) |
| <a id="probeid-1"></a> `probeId` | `string` |
| <a id="removedpayloadfields"></a> `removedPayloadFields` | `string`[] |
| <a id="result-2"></a> `result` | [`AssuranceProbeResult`](#assuranceproberesult) |

***

<a id="mutationcandidate"></a>

### MutationCandidate

#### Extends

- [`ProbeMutation`](#probemutation)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="description-2"></a> `description` | `string` |
| <a id="dimension"></a> `dimension` | [`MutationDimension`](#mutationdimension) |
| <a id="id-9"></a> `id?` | `string` |
| <a id="operation-1"></a> `operation` | [`FirebaseOperation`](#firebaseoperation) |

***

<a id="operationevidence"></a>

### OperationEvidence

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="decision"></a> `decision` | [`AssuranceDecision`](#assurancedecision) |
| <a id="error-1"></a> `error?` | \{ `code?`: `string`; `message`: `string`; \} |
| `error.code?` | `string` |
| `error.message` | `string` |
| <a id="events"></a> `events` | [`AssuranceEventEvidence`](#assuranceeventevidence)[] |
| <a id="operation-2"></a> `operation` | [`FirebaseOperation`](#firebaseoperation) |
| <a id="output"></a> `output?` | `unknown` |

***

<a id="probemutation"></a>

### ProbeMutation

#### Extended by

- [`MutationCandidate`](#mutationcandidate)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="description-3"></a> `description` | `string` |
| <a id="dimension-1"></a> `dimension` | [`MutationDimension`](#mutationdimension) |
| <a id="operation-3"></a> `operation` | [`FirebaseOperation`](#firebaseoperation) |

***

<a id="proposalinput"></a>

### ProposalInput

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="invariantid-1"></a> `invariantId` | `string` |
| <a id="mutations"></a> `mutations` | [`MutationCandidate`](#mutationcandidate)[] |
| <a id="observationid"></a> `observationId` | `string` |

***

<a id="rtdboperation"></a>

### RtdbOperation

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data-1"></a> `data?` | `unknown` |
| <a id="method-2"></a> `method` | `"get"` \| `"set"` \| `"update"` \| `"remove"` |
| <a id="path-2"></a> `path` | `string` |
| <a id="query-1"></a> `query?` | \{ `endAt?`: \{ `key?`: `string`; `value`: `unknown`; \}; `endBefore?`: \{ `key?`: `string`; `value`: `unknown`; \}; `equalTo?`: \{ `key?`: `string`; `value`: `unknown`; \}; `limitToFirst?`: `number`; `limitToLast?`: `number`; `orderBy?`: \| \{ `kind`: `"child"`; `path`: `string`; \} \| \{ `kind`: `"key"`; \} \| \{ `kind`: `"value"`; \}; `startAfter?`: \{ `key?`: `string`; `value`: `unknown`; \}; `startAt?`: \{ `key?`: `string`; `value`: `unknown`; \}; \} |
| `query.endAt?` | \{ `key?`: `string`; `value`: `unknown`; \} |
| `query.endAt.key?` | `string` |
| `query.endAt.value` | `unknown` |
| `query.endBefore?` | \{ `key?`: `string`; `value`: `unknown`; \} |
| `query.endBefore.key?` | `string` |
| `query.endBefore.value` | `unknown` |
| `query.equalTo?` | \{ `key?`: `string`; `value`: `unknown`; \} |
| `query.equalTo.key?` | `string` |
| `query.equalTo.value` | `unknown` |
| `query.limitToFirst?` | `number` |
| `query.limitToLast?` | `number` |
| `query.orderBy?` | \| \{ `kind`: `"child"`; `path`: `string`; \} \| \{ `kind`: `"key"`; \} \| \{ `kind`: `"value"`; \} |
| `query.startAfter?` | \{ `key?`: `string`; `value`: `unknown`; \} |
| `query.startAfter.key?` | `string` |
| `query.startAfter.value` | `unknown` |
| `query.startAt?` | \{ `key?`: `string`; `value`: `unknown`; \} |
| `query.startAt.key?` | `string` |
| `query.startAt.value` | `unknown` |
| <a id="service-4"></a> `service` | `"rtdb"` |

***

<a id="runsecuritycasesinput"></a>

### RunSecurityCasesInput

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="actors-1"></a> `actors` | [`AssuranceActor`](#assuranceactor)[] |
| <a id="campaignid-3"></a> `campaignId` | `string` |
| <a id="cases-1"></a> `cases` | [`SecurityCase`](#securitycase)[] |
| <a id="target-4"></a> `target` | [`LocalFirebaseTarget`](#localfirebasetarget) |

***

<a id="sandboxattachmentprovideroptions"></a>

### SandboxAttachmentProviderOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="fetchimpl"></a> `fetchImpl?` | *typeof* `fetch` |
| <a id="origin-2"></a> `origin?` | `string` |

***

<a id="securitycase"></a>

### SecurityCase

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="actorid-3"></a> `actorId` | `string` |
| <a id="campaignid-4"></a> `campaignId` | `string` |
| <a id="control-2"></a> `control` | [`FirebaseOperation`](#firebaseoperation) |
| <a id="expect"></a> `expect` | `"ALLOW"` \| `"DENY"` |
| <a id="id-10"></a> `id` | `string` |
| <a id="invariant-1"></a> `invariant` | [`SecurityInvariant`](#securityinvariant) |
| <a id="mutation-2"></a> `mutation` | [`ProbeMutation`](#probemutation) |
| <a id="qualification-1"></a> `qualification` | [`EngineQualification`](#enginequalification) |
| <a id="schema-5"></a> `schema` | `"pyric.assurance.case.v1"` |

***

<a id="securityinvariant"></a>

### SecurityInvariant

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="confidence"></a> `confidence` | `"authoritative"` \| `"strong"` \| `"tentative"` |
| <a id="expected"></a> `expected` | `"ALLOW"` \| `"DENY"` |
| <a id="id-11"></a> `id` | `string` |
| <a id="service-5"></a> `service` | [`AssuranceService`](#assuranceservice) \| `"cross-service"` |
| <a id="source-2"></a> `source` | `"captured"` \| `"declared"` \| `"authored-test"` \| `"derived"` \| `"agent"` |
| <a id="statement"></a> `statement` | `string` |

***

<a id="statediff-1"></a>

### StateDiff

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="after"></a> `after` | `unknown` |
| <a id="before"></a> `before` | `unknown` |
| <a id="changed-1"></a> `changed` | `boolean` |

***

<a id="storageobjectfixture"></a>

### StorageObjectFixture

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="contenttype"></a> `contentType?` | `string` |
| <a id="custommetadata"></a> `customMetadata?` | `Record`\<`string`, `string`\> |
| <a id="database64"></a> `dataBase64` | `string` |
| <a id="path-3"></a> `path` | `string` |

***

<a id="storageoperation"></a>

### StorageOperation

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="contenttype-1"></a> `contentType?` | `string` |
| <a id="custommetadata-1"></a> `customMetadata?` | `Record`\<`string`, `string`\> |
| <a id="database64-1"></a> `dataBase64?` | `string` |
| <a id="method-3"></a> `method` | `"get"` \| `"list"` \| `"delete"` \| `"upload"` \| `"updateMetadata"` |
| <a id="path-4"></a> `path` | `string` |
| <a id="service-6"></a> `service` | `"storage"` |

## Type Aliases

<a id="actoracquisition"></a>

### ActorAcquisition

```ts
type ActorAcquisition =
  | {
  kind: "anonymous-request";
}
  | {
  kind: "anonymous-account";
}
  | {
  email: string;
  kind: "password";
  password: string;
}
  | {
  kind: "fixture-user";
  uid: string;
}
  | {
  kind: "synthetic";
  token?: Record<string, unknown>;
  uid: string;
};
```

***

<a id="assuranceattachmentprovider"></a>

### AssuranceAttachmentProvider()

```ts
type AssuranceAttachmentProvider = (input: AssuranceAttachmentInput) => Promise<AssuranceAttachment>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | [`AssuranceAttachmentInput`](#assuranceattachmentinput) |

#### Returns

`Promise`\<[`AssuranceAttachment`](#assuranceattachment)\>

***

<a id="assurancedecision"></a>

### AssuranceDecision

```ts
type AssuranceDecision = "ALLOW" | "DENY" | "ERROR" | "UNSUPPORTED";
```

***

<a id="assuranceservice"></a>

### AssuranceService

```ts
type AssuranceService = "firestore" | "rtdb" | "storage";
```

***

<a id="firebaseoperation"></a>

### FirebaseOperation

```ts
type FirebaseOperation =
  | FirestoreOperation
  | RtdbOperation
  | StorageOperation;
```

***

<a id="mutationdimension"></a>

### MutationDimension

```ts
type MutationDimension = "path" | "query" | "payload" | "operation";
```

***

<a id="probeclassification"></a>

### ProbeClassification

```ts
type ProbeClassification =
  | "local-counterexample"
  | "candidate-signal"
  | "no-counterexample"
  | "engine-gap"
  | "invalid-probe";
```

## Variables

<a id="assurance_broadcast_channel"></a>

### ASSURANCE\_BROADCAST\_CHANNEL

```ts
const ASSURANCE_BROADCAST_CHANNEL: "pyric-assurance-v1" = "pyric-assurance-v1";
```

***

<a id="assurance_browser_event"></a>

### ASSURANCE\_BROWSER\_EVENT

```ts
const ASSURANCE_BROWSER_EVENT: "pyric:assurance-campaign" = "pyric:assurance-campaign";
```

***

<a id="assurance_campaign_schema"></a>

### ASSURANCE\_CAMPAIGN\_SCHEMA

```ts
const ASSURANCE_CAMPAIGN_SCHEMA: "pyric.assurance.campaign.v1";
```

***

<a id="assurance_engine_capabilities"></a>

### ASSURANCE\_ENGINE\_CAPABILITIES

```ts
const ASSURANCE_ENGINE_CAPABILITIES: readonly GeneratedAssuranceCapability[];
```

***

<a id="assurance_report_schema"></a>

### ASSURANCE\_REPORT\_SCHEMA

```ts
const ASSURANCE_REPORT_SCHEMA: "pyric.assurance.report.v1";
```

***

<a id="assurance_target_schema"></a>

### ASSURANCE\_TARGET\_SCHEMA

```ts
const ASSURANCE_TARGET_SCHEMA: "pyric.assurance.target.v1";
```

***

<a id="defaultassurancecampaignstore"></a>

### defaultAssuranceCampaignStore

```ts
const defaultAssuranceCampaignStore: AssuranceCampaignStore;
```

## Functions

<a id="capabilityreasons"></a>

### capabilityReasons()

```ts
function capabilityReasons(capability: GeneratedAssuranceCapability): string[];
```

The reasons a probe cites when it abstains: the dependencies whose verdict
 pinned the capability's status, each rendered as a sentence.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `capability` | [`GeneratedAssuranceCapability`](#generatedassurancecapability) |

#### Returns

`string`[]

***

<a id="createassurancetools"></a>

### createAssuranceTools()

```ts
function createAssuranceTools(deps?: AssuranceToolDeps): ToolHandler<unknown, unknown>[];
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `deps?` | [`AssuranceToolDeps`](#assurancetooldeps) |

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

<a id="createauthorizationcampaign"></a>

### createAuthorizationCampaign()

```ts
function createAuthorizationCampaign(options: CreateAuthorizationCampaignOptions): AuthorizationCampaign;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`CreateAuthorizationCampaignOptions`](#createauthorizationcampaignoptions) |

#### Returns

[`AuthorizationCampaign`](#authorizationcampaign)

***

<a id="createsandboxattachmentprovider"></a>

### createSandboxAttachmentProvider()

```ts
function createSandboxAttachmentProvider(sandbox: Sandbox, options?: SandboxAttachmentProviderOptions): AssuranceAttachmentProvider;
```

Clone the sandbox currently hosting the connected bridge peer. The URL is an
origin assertion and source for explicit rules metadata; no arbitrary host is
contacted and the returned campaign target itself keeps networking forbidden.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |
| `options?` | [`SandboxAttachmentProviderOptions`](#sandboxattachmentprovideroptions) |

#### Returns

[`AssuranceAttachmentProvider`](#assuranceattachmentprovider)

***

<a id="listassurancecapabilities"></a>

### listAssuranceCapabilities()

```ts
function listAssuranceCapabilities(services?: readonly AssuranceCapabilityService[]): GeneratedAssuranceCapability[];
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `services?` | readonly `AssuranceCapabilityService`[] |

#### Returns

[`GeneratedAssuranceCapability`](#generatedassurancecapability)[]

***

<a id="publishassurancevisualization"></a>

### publishAssuranceVisualization()

```ts
function publishAssuranceVisualization(snapshot: AssuranceVisualizationSnapshot): void;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `snapshot` | [`AssuranceVisualizationSnapshot`](#assurancevisualizationsnapshot) |

#### Returns

`void`

***

<a id="qualifyprobe"></a>

### qualifyProbe()

```ts
function qualifyProbe(target: LocalFirebaseTarget, probe: AssuranceProbe): EngineQualification;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `target` | [`LocalFirebaseTarget`](#localfirebasetarget) |
| `probe` | [`AssuranceProbe`](#assuranceprobe) |

#### Returns

[`EngineQualification`](#enginequalification)

***

<a id="runauthorizationcampaign"></a>

### runAuthorizationCampaign()

```ts
function runAuthorizationCampaign(spec: AuthorizationCampaignSpec): Promise<AuthorizationCampaignReport>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `spec` | [`AuthorizationCampaignSpec`](#authorizationcampaignspec-2) |

#### Returns

`Promise`\<[`AuthorizationCampaignReport`](#authorizationcampaignreport-1)\>

***

<a id="runsecuritycases"></a>

### runSecurityCases()

```ts
function runSecurityCases(input: RunSecurityCasesInput): Promise<AuthorizationCampaignReport>;
```

Re-run exported expectations against a candidate local target. Each case
keeps its known-good control and explicit negative expectation, so a rules
change must preserve the application workflow and reject the boundary case.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | [`RunSecurityCasesInput`](#runsecuritycasesinput) |

#### Returns

`Promise`\<[`AuthorizationCampaignReport`](#authorizationcampaignreport-1)\>

***

<a id="subscribeassurancevisualizations"></a>

### subscribeAssuranceVisualizations()

```ts
function subscribeAssuranceVisualizations(listener: (snapshot: AssuranceVisualizationSnapshot) => void): () => void;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `listener` | (`snapshot`: [`AssuranceVisualizationSnapshot`](#assurancevisualizationsnapshot)) => `void` |

#### Returns

```ts
(): void;
```

##### Returns

`void`

## References

<a id="assuranceenginecapability"></a>

### AssuranceEngineCapability

Renames and re-exports [GeneratedAssuranceCapability](#generatedassurancecapability)
