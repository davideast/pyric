<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/assurance/browser

## Interfaces

### AssuranceVisualizationSnapshot

Credential-free projection safe to hand to Studio visualization code.

#### Properties

##### campaignId

> **campaignId**: `string`

##### context?

> `optional` **context**: `AssuranceCampaignContext`

##### observations

> **observations**: `AssuranceObservation`[]

##### probes

> **probes**: `AssuranceProbe`[]

##### report?

> `optional` **report**: `AuthorizationCampaignReport`

##### schema

> **schema**: `"pyric.assurance.visualization.v1"`

##### verifications?

> `optional` **verifications**: `AuthorizationCampaignReport`[]

## Variables

### ASSURANCE\_BROADCAST\_CHANNEL

> `const` **ASSURANCE\_BROADCAST\_CHANNEL**: `"pyric-assurance-v1"` = `"pyric-assurance-v1"`

***

### ASSURANCE\_BROWSER\_EVENT

> `const` **ASSURANCE\_BROWSER\_EVENT**: `"pyric:assurance-campaign"` = `"pyric:assurance-campaign"`

## Functions

### publishAssuranceVisualization()

> **publishAssuranceVisualization**(`snapshot`): `void`

#### Parameters

##### snapshot

[`AssuranceVisualizationSnapshot`](#assurancevisualizationsnapshot)

#### Returns

`void`

***

### subscribeAssuranceVisualizations()

> **subscribeAssuranceVisualizations**(`listener`): () => `void`

#### Parameters

##### listener

(`snapshot`) => `void`

#### Returns

> (): `void`

##### Returns

`void`
