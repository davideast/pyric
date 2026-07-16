---
title: "API reference: @pyric/cli/assurance/browser"
navLabel: "@pyric/cli/assurance/browser"
outcome: "Published declarations for @pyric/cli/assurance/browser."
slug: "pyric-cli-assurance-browser-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/assurance/browser"
apiSubpath: "assurance/browser"
apiSymbolCount: 5
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="assurancevisualizationsnapshot"></a>

### AssuranceVisualizationSnapshot

Credential-free projection safe to hand to Studio visualization code.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="campaignid"></a> `campaignId` | `string` |
| <a id="context"></a> `context?` | `AssuranceCampaignContext` |
| <a id="observations"></a> `observations` | `AssuranceObservation`[] |
| <a id="probes"></a> `probes` | `AssuranceProbe`[] |
| <a id="report"></a> `report?` | `AuthorizationCampaignReport` |
| <a id="schema"></a> `schema` | `"pyric.assurance.visualization.v1"` |
| <a id="verifications"></a> `verifications?` | `AuthorizationCampaignReport`[] |

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

## Functions

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
