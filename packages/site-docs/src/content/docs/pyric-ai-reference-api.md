---
title: "API reference: pyric/ai"
navLabel: "pyric/ai"
group: "API reference"
section: "pyric"
order: 24008
description: "Published declarations for pyric/ai."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/ai"
apiSubpath: "ai"
apiSymbolCount: 132
apiEvidenceSlug: "pyric-ai-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="aierror"></a>

### AIError

Error class for the AI mirror — constructor and message format copied
from the installed SDK: `AI: <message> (AI/<code>)`, `code` set to the
short code, `customErrorData` carried through.

#### Extends

- `FirebaseError`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new AIError(
   code: AIErrorCode,
   message: string,
   customErrorData?: CustomErrorData): AIError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `code` | [`AIErrorCode`](#aierrorcode-1) |
| `message` | `string` |
| `customErrorData?` | [`CustomErrorData`](#customerrordata-1) |

###### Returns

[`AIError`](#aierror)

###### Overrides

```ts
FirebaseError.constructor
```

#### Properties

| Property | Modifier | Type | Default value | Overrides |
| :------ | :------ | :------ | :------ | :------ |
| <a id="code"></a> `code` | `readonly` | [`AIErrorCode`](#aierrorcode-1) | `undefined` | `FirebaseError.code` |
| <a id="customdata"></a> `customData?` | `readonly` | `Record`\<`string`, `unknown`\> | `undefined` | - |
| <a id="customerrordata"></a> `customErrorData?` | `readonly` | [`CustomErrorData`](#customerrordata-1) | `undefined` | - |
| <a id="name"></a> `name` | `readonly` | `"FirebaseError"` | `"FirebaseError"` | - |

***

<a id="aimodel"></a>

### `abstract` AIModel

Base class for AI model APIs; holds the normalized model resource name.

#### Extended by

- [`GenerativeModel`](#generativemodel)

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
protected new AIModel(modelName: string): AIModel;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `modelName` | `string` |

###### Returns

[`AIModel`](#aimodel)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="model"></a> `model` | `readonly` | `string` | Fully qualified model resource name (`models/<name>` on GoogleAI). |

#### Methods

<a id="normalizemodelname"></a>

##### normalizeModelName()

```ts
static normalizeModelName(modelName: string): string;
```

GoogleAI normalization WITHOUT the installed 2.12.0 double-prefix wart:
`models/x` stays `models/x`, a short name gains the prefix (registry row
ai#model-name-prefixed).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `modelName` | `string` |

###### Returns

`string`

***

<a id="anyofschema"></a>

### AnyOfSchema

Schema for a value conforming to ANY of the provided sub-schemas.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new AnyOfSchema(schemaParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="anyof"></a> `anyOf` | [`TypedSchema`](#typedschema)[] |
| <a id="format"></a> `format?` | `string` |
| <a id="nullable"></a> `nullable` | `boolean` |
| <a id="type"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-1"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="arrayschema"></a>

### ArraySchema

Schema class for "array" types; `items` is the member schema.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-3"></a>

##### Constructor

```ts
new ArraySchema(schemaParams: SchemaParams, items: TypedSchema): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams` | [`SchemaParams`](#schemaparams) |
| `items` | [`TypedSchema`](#typedschema) |

###### Returns

[`ArraySchema`](#arrayschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-1"></a> `format?` | `string` |
| <a id="items"></a> `items` | [`TypedSchema`](#typedschema) |
| <a id="nullable-1"></a> `nullable` | `boolean` |
| <a id="type-1"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-2"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-3"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array-2"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean-2"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring-2"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer-2"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number-2"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object-2"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string-2"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="backend"></a>

### `abstract` Backend

Abstract base class representing the configuration for an AI service
backend. Do not instantiate directly — use [GoogleAIBackend](#googleaibackend) or
[VertexAIBackend](#vertexaibackend).

#### Extended by

- [`GoogleAIBackend`](#googleaibackend)
- [`VertexAIBackend`](#vertexaibackend)

#### Constructors

<a id="constructor-4"></a>

##### Constructor

```ts
protected new Backend(type: BackendType): Backend;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `type` | [`BackendType`](#backendtype-3) |

###### Returns

[`Backend`](#backend)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="backendtype"></a> `backendType` | `readonly` | [`BackendType`](#backendtype-3) |

***

<a id="booleanschema"></a>

### BooleanSchema

Schema class for "boolean" types.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-5"></a>

##### Constructor

```ts
new BooleanSchema(schemaParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-2"></a> `format?` | `string` |
| <a id="nullable-2"></a> `nullable` | `boolean` |
| <a id="type-2"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-4"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Inherited from

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-5"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array-4"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean-4"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring-4"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer-4"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number-4"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object-4"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string-4"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="chatsession"></a>

### ChatSession

Chat session for multi-turn conversations on a sandbox target.

#### Extends

- [`ChatSessionBase`](#chatsessionbase)

#### Constructors

<a id="constructor-6"></a>

##### Constructor

```ts
new ChatSession(
   target: AITarget,
   model: string,
   params?: StartChatParams,
   requestOptions?: RequestOptions): ChatSession;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `target` | `AITarget` |
| `model` | `string` |
| `params?` | [`StartChatParams`](#startchatparams) |
| `requestOptions?` | [`RequestOptions`](#requestoptions-2) |

###### Returns

[`ChatSession`](#chatsession)

###### Overrides

[`ChatSessionBase`](#chatsessionbase).[`constructor`](#constructor-7)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="model-1"></a> `model` | `readonly` | `string` |
| <a id="params"></a> `params` | `readonly` | [`StartChatParams`](#startchatparams) |
| <a id="requestoptions"></a> `requestOptions` | `readonly` | [`RequestOptions`](#requestoptions-2) |

#### Methods

<a id="gethistory"></a>

##### getHistory()

```ts
getHistory(): Promise<ContentShape[]>;
```

Chat history so far. Blocked prompts leave no trace: neither blocked
candidates nor the prompts that generated them are recorded. Returns a
defensive clone — mutations never corrupt the session.

###### Returns

`Promise`\<`ContentShape`[]\>

###### Inherited from

[`ChatSessionBase`](#chatsessionbase).[`getHistory`](#gethistory-2)

<a id="sendmessage"></a>

##### sendMessage()

```ts
sendMessage(request: RequestInput, singleRequestOptions?: SingleRequestOptions): Promise<GenerateContentResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | `RequestInput` |
| `singleRequestOptions?` | [`SingleRequestOptions`](#singlerequestoptions) |

###### Returns

`Promise`\<[`GenerateContentResult`](#generatecontentresult)\>

<a id="sendmessagestream"></a>

##### sendMessageStream()

```ts
sendMessageStream(request: RequestInput, singleRequestOptions?: SingleRequestOptions): Promise<GenerateContentStreamResult>;
```

Streaming chat turn — 2.13.0 FIXED semantics: the incoming content is
threaded into the request exactly once, and exactly one user turn lands
in history per call (registry row ai#chat-stream-single-user-turn).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | `RequestInput` |
| `singleRequestOptions?` | [`SingleRequestOptions`](#singlerequestoptions) |

###### Returns

`Promise`\<[`GenerateContentStreamResult`](#generatecontentstreamresult)\>

***

<a id="chatsessionbase"></a>

### `abstract` ChatSessionBase

Base class for chat sessions: history storage and the sequential-send
guarantee (`_sendPromise` chain, upstream pattern — later sends and
`getHistory()` observe earlier turns in order).

#### Extended by

- [`ChatSession`](#chatsession)

#### Constructors

<a id="constructor-7"></a>

##### Constructor

```ts
new ChatSessionBase(): ChatSessionBase;
```

###### Returns

[`ChatSessionBase`](#chatsessionbase)

#### Methods

<a id="gethistory-2"></a>

##### getHistory()

```ts
getHistory(): Promise<ContentShape[]>;
```

Chat history so far. Blocked prompts leave no trace: neither blocked
candidates nor the prompts that generated them are recorded. Returns a
defensive clone — mutations never corrupt the session.

###### Returns

`Promise`\<`ContentShape`[]\>

***

<a id="generativemodel"></a>

### GenerativeModel

Class for generative model APIs on a sandbox target.

#### Extends

- [`AIModel`](#aimodel)

#### Constructors

<a id="constructor-8"></a>

##### Constructor

```ts
new GenerativeModel(
   target: AITarget,
   modelParams: ModelParams,
   requestOptions?: RequestOptions): GenerativeModel;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `target` | `AITarget` |
| `modelParams` | [`ModelParams`](#modelparams) |
| `requestOptions?` | [`RequestOptions`](#requestoptions-2) |

###### Returns

[`GenerativeModel`](#generativemodel)

###### Overrides

[`AIModel`](#aimodel).[`constructor`](#constructor-1)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="generationconfig"></a> `generationConfig` | `readonly` | `Record`\<`string`, `unknown`\> | - |
| <a id="model-2"></a> `model` | `readonly` | `string` | Fully qualified model resource name (`models/<name>` on GoogleAI). |
| <a id="requestoptions-1"></a> `requestOptions` | `readonly` | [`RequestOptions`](#requestoptions-2) | - |
| <a id="safetysettings"></a> `safetySettings` | `readonly` | `unknown`[] | - |
| <a id="systeminstruction"></a> `systemInstruction?` | `readonly` | `ContentShape` | - |
| <a id="toolconfig"></a> `toolConfig?` | `readonly` | `unknown` | - |
| <a id="tools"></a> `tools?` | `readonly` | `unknown`[] | - |

#### Methods

<a id="counttokens"></a>

##### countTokens()

```ts
countTokens(request: RequestInput | GenerateContentRequestShape, singleRequestOptions?: SingleRequestOptions): Promise<CountTokensResponse>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | `RequestInput` \| `GenerateContentRequestShape` |
| `singleRequestOptions?` | [`SingleRequestOptions`](#singlerequestoptions) |

###### Returns

`Promise`\<`CountTokensResponse`\>

<a id="generatecontent"></a>

##### generateContent()

```ts
generateContent(request: RequestInput | GenerateContentRequestShape, singleRequestOptions?: SingleRequestOptions): Promise<GenerateContentResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | `RequestInput` \| `GenerateContentRequestShape` |
| `singleRequestOptions?` | [`SingleRequestOptions`](#singlerequestoptions) |

###### Returns

`Promise`\<[`GenerateContentResult`](#generatecontentresult)\>

<a id="generatecontentstream"></a>

##### generateContentStream()

```ts
generateContentStream(request: RequestInput | GenerateContentRequestShape, singleRequestOptions?: SingleRequestOptions): Promise<GenerateContentStreamResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | `RequestInput` \| `GenerateContentRequestShape` |
| `singleRequestOptions?` | [`SingleRequestOptions`](#singlerequestoptions) |

###### Returns

`Promise`\<[`GenerateContentStreamResult`](#generatecontentstreamresult)\>

<a id="startchat"></a>

##### startChat()

```ts
startChat(startChatParams?: StartChatParams): ChatSession;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `startChatParams?` | [`StartChatParams`](#startchatparams) |

###### Returns

[`ChatSession`](#chatsession)

<a id="normalizemodelname-2"></a>

##### normalizeModelName()

```ts
static normalizeModelName(modelName: string): string;
```

GoogleAI normalization WITHOUT the installed 2.12.0 double-prefix wart:
`models/x` stays `models/x`, a short name gains the prefix (registry row
ai#model-name-prefixed).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `modelName` | `string` |

###### Returns

`string`

###### Inherited from

[`AIModel`](#aimodel).[`normalizeModelName`](#normalizemodelname)

***

<a id="googleaibackend"></a>

### GoogleAIBackend

Configuration class for the Gemini Developer API backend (the default).

#### Extends

- [`Backend`](#backend)

#### Constructors

<a id="constructor-9"></a>

##### Constructor

```ts
new GoogleAIBackend(): GoogleAIBackend;
```

###### Returns

[`GoogleAIBackend`](#googleaibackend)

###### Overrides

[`Backend`](#backend).[`constructor`](#constructor-4)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="backendtype-1"></a> `backendType` | `readonly` | [`BackendType`](#backendtype-3) |

***

<a id="integerschema"></a>

### IntegerSchema

Schema class for "integer" types.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-10"></a>

##### Constructor

```ts
new IntegerSchema(schemaParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-3"></a> `format?` | `string` |
| <a id="nullable-3"></a> `nullable` | `boolean` |
| <a id="type-3"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-6"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Inherited from

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-7"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array-6"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean-6"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring-6"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer-6"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number-6"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object-6"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string-6"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="numberschema"></a>

### NumberSchema

Schema class for "number" types.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-11"></a>

##### Constructor

```ts
new NumberSchema(schemaParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-4"></a> `format?` | `string` |
| <a id="nullable-4"></a> `nullable` | `boolean` |
| <a id="type-4"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-8"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Inherited from

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-9"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array-8"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean-8"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring-8"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer-8"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number-8"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object-8"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string-8"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="objectschema"></a>

### ObjectSchema

Schema class for "object" types; `properties` maps names to Schemas.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-12"></a>

##### Constructor

```ts
new ObjectSchema(
   schemaParams: SchemaParams,
   properties: Record<string, TypedSchema>,
   optionalProperties?: string[]): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams` | [`SchemaParams`](#schemaparams) |
| `properties` | `Record`\<`string`, [`TypedSchema`](#typedschema)\> |
| `optionalProperties?` | `string`[] |

###### Returns

[`ObjectSchema`](#objectschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-5"></a> `format?` | `string` |
| <a id="nullable-5"></a> `nullable` | `boolean` |
| <a id="optionalproperties"></a> `optionalProperties` | `string`[] |
| <a id="properties"></a> `properties` | `Record`\<`string`, [`TypedSchema`](#typedschema)\> |
| <a id="type-5"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-10"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-11"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array-10"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean-10"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring-10"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer-10"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number-10"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object-10"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string-10"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="schema"></a>

### `abstract` Schema

Parent class encompassing all Schema types. Converts with
`JSON.stringify()` into the JSON string the REST endpoints accept.

#### Extended by

- [`AnyOfSchema`](#anyofschema)
- [`ArraySchema`](#arrayschema)
- [`BooleanSchema`](#booleanschema)
- [`IntegerSchema`](#integerschema)
- [`NumberSchema`](#numberschema)
- [`ObjectSchema`](#objectschema)
- [`StringSchema`](#stringschema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-13"></a>

##### Constructor

```ts
new Schema(schemaParams: SchemaParams): Schema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams` | [`SchemaParams`](#schemaparams) |

###### Returns

[`Schema`](#schema)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="format-6"></a> `format?` | `string` |
| <a id="nullable-6"></a> `nullable` | `boolean` |
| <a id="type-6"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-12"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

<a id="anyof-13"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

<a id="array-12"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

<a id="boolean-12"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

<a id="enumstring-12"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

<a id="integer-12"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

<a id="number-12"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

<a id="object-12"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

<a id="string-12"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

***

<a id="stringschema"></a>

### StringSchema

Schema class for "string" types, with or without enum values.

#### Extends

- [`Schema`](#schema)

#### Indexable

```ts
[key: string]: unknown
```

#### Constructors

<a id="constructor-14"></a>

##### Constructor

```ts
new StringSchema(schemaParams?: SchemaParams, enumValues?: string[]): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `schemaParams?` | [`SchemaParams`](#schemaparams) |
| `enumValues?` | `string`[] |

###### Returns

[`StringSchema`](#stringschema)

###### Overrides

[`Schema`](#schema).[`constructor`](#constructor-13)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="enum"></a> `enum?` | `string`[] |
| <a id="format-7"></a> `format?` | `string` |
| <a id="nullable-7"></a> `nullable` | `boolean` |
| <a id="type-7"></a> `type?` | [`SchemaType`](#schematype-1) |

#### Methods

<a id="tojson-14"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialization the request body applies via `JSON.stringify`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`Schema`](#schema).[`toJSON`](#tojson-12)

<a id="anyof-15"></a>

##### anyOf()

```ts
static anyOf(anyOfParams: SchemaParams & {
  anyOf: TypedSchema[];
}): AnyOfSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `anyOfParams` | [`SchemaParams`](#schemaparams) & \{ `anyOf`: [`TypedSchema`](#typedschema)[]; \} |

###### Returns

[`AnyOfSchema`](#anyofschema)

###### Inherited from

[`Schema`](#schema).[`anyOf`](#anyof-13)

<a id="array-14"></a>

##### array()

```ts
static array(arrayParams: SchemaParams & {
  items: TypedSchema;
}): ArraySchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `arrayParams` | [`SchemaParams`](#schemaparams) & \{ `items`: [`TypedSchema`](#typedschema); \} |

###### Returns

[`ArraySchema`](#arrayschema)

###### Inherited from

[`Schema`](#schema).[`array`](#array-12)

<a id="boolean-14"></a>

##### boolean()

```ts
static boolean(booleanParams?: SchemaParams): BooleanSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `booleanParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`BooleanSchema`](#booleanschema)

###### Inherited from

[`Schema`](#schema).[`boolean`](#boolean-12)

<a id="enumstring-14"></a>

##### enumString()

```ts
static enumString(stringParams: SchemaParams & {
  enum: string[];
}): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams` | [`SchemaParams`](#schemaparams) & \{ `enum`: `string`[]; \} |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`enumString`](#enumstring-12)

<a id="integer-14"></a>

##### integer()

```ts
static integer(integerParams?: SchemaParams): IntegerSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `integerParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`IntegerSchema`](#integerschema)

###### Inherited from

[`Schema`](#schema).[`integer`](#integer-12)

<a id="number-14"></a>

##### number()

```ts
static number(numberParams?: SchemaParams): NumberSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `numberParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`NumberSchema`](#numberschema)

###### Inherited from

[`Schema`](#schema).[`number`](#number-12)

<a id="object-14"></a>

##### object()

```ts
static object(objectParams: SchemaParams & {
  optionalProperties?: string[];
  properties: Record<string, TypedSchema>;
}): ObjectSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `objectParams` | [`SchemaParams`](#schemaparams) & \{ `optionalProperties?`: `string`[]; `properties`: `Record`\<`string`, [`TypedSchema`](#typedschema)\>; \} |

###### Returns

[`ObjectSchema`](#objectschema)

###### Inherited from

[`Schema`](#schema).[`object`](#object-12)

<a id="string-14"></a>

##### string()

```ts
static string(stringParams?: SchemaParams): StringSchema;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `stringParams?` | [`SchemaParams`](#schemaparams) |

###### Returns

[`StringSchema`](#stringschema)

###### Inherited from

[`Schema`](#schema).[`string`](#string-12)

***

<a id="vertexaibackend"></a>

### VertexAIBackend

Configuration class for the Vertex AI Gemini API backend.

#### Extends

- [`Backend`](#backend)

#### Constructors

<a id="constructor-15"></a>

##### Constructor

```ts
new VertexAIBackend(location?: string): VertexAIBackend;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `location?` | `string` |

###### Returns

[`VertexAIBackend`](#vertexaibackend)

###### Overrides

[`Backend`](#backend).[`constructor`](#constructor-4)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="backendtype-2"></a> `backendType` | `readonly` | [`BackendType`](#backendtype-3) |
| <a id="location"></a> `location` | `readonly` | `string` |

## Interfaces

<a id="ai"></a>

### AI

Sandbox AI handle. Direct sandbox handles have no `app`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="app"></a> `app?` | `FirebaseApp` |
| <a id="backend-1"></a> `backend` | [`Backend`](#backend) |
| <a id="location-1"></a> `location` | `string` |
| <a id="options"></a> `options?` | [`AIOptions`](#aioptions-1) |

***

<a id="aioptions-1"></a>

### AIOptions

Initialization options; `engine` is the sandbox-only answer-engine seam.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="backend-2"></a> `backend?` | [`Backend`](#backend) | - |
| <a id="engine"></a> `engine?` | `EngineConfig` \| `AnswerEngine` | Sandbox targets only: engine config (`scripted` default) or a custom engine. |
| <a id="uselimiteduseappchecktokens"></a> `useLimitedUseAppCheckTokens?` | `boolean` | - |

***

<a id="baseparams"></a>

### BaseParams

#### Extended by

- [`ModelParams`](#modelparams)
- [`StartChatParams`](#startchatparams)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="generationconfig-1"></a> `generationConfig?` | `Record`\<`string`, `unknown`\> |
| <a id="safetysettings-1"></a> `safetySettings?` | `unknown`[] |

***

<a id="citation"></a>

### Citation

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="endindex"></a> `endIndex?` | `number` |
| <a id="license"></a> `license?` | `string` |
| <a id="publicationdate"></a> `publicationDate?` | [`Date`](#date) |
| <a id="startindex"></a> `startIndex?` | `number` |
| <a id="title"></a> `title?` | `string` |
| <a id="uri"></a> `uri?` | `string` |

***

<a id="citationmetadata"></a>

### CitationMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="citations"></a> `citations` | [`Citation`](#citation)[] |

***

<a id="codeexecutionresult"></a>

### CodeExecutionResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="outcome"></a> `outcome?` | `string` |
| <a id="output"></a> `output?` | `string` |

***

<a id="codeexecutionresultpart"></a>

### CodeExecutionResultPart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-1"></a> `codeExecutionResult?` | [`CodeExecutionResult`](#codeexecutionresult) |
| <a id="executablecode"></a> `executableCode?` | `never` |
| <a id="filedata"></a> `fileData` | `never` |
| <a id="functioncall"></a> `functionCall?` | `never` |
| <a id="functionresponse"></a> `functionResponse?` | `never` |
| <a id="inlinedata"></a> `inlineData?` | `never` |
| <a id="text"></a> `text?` | `never` |
| <a id="thought"></a> `thought?` | `never` |

***

<a id="codeexecutiontool"></a>

### CodeExecutionTool

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecution"></a> `codeExecution` | `Record`\<`string`, `never`\> |

***

<a id="content"></a>

### Content

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="parts"></a> `parts` | [`Part`](#part)[] |
| <a id="role"></a> `role` | `"function"` \| `"user"` \| `"model"` \| `"system"` |

***

<a id="counttokensrequest"></a>

### CountTokensRequest

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="contents"></a> `contents` | [`Content`](#content)[] |
| <a id="generationconfig-2"></a> `generationConfig?` | [`GenerationConfig`](#generationconfig-4) |
| <a id="systeminstruction-1"></a> `systemInstruction?` | `string` \| [`Content`](#content) \| [`Part`](#part) |
| <a id="tools-1"></a> `tools?` | [`Tool`](#tool)[] |

***

<a id="counttokensresponse"></a>

### CountTokensResponse

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="prompttokensdetails"></a> `promptTokensDetails?` | [`ModalityTokenCount`](#modalitytokencount)[] |
| <a id="totalbillablecharacters"></a> `totalBillableCharacters?` | `number` |
| <a id="totaltokens"></a> `totalTokens` | `number` |

***

<a id="customerrordata-1"></a>

### CustomErrorData

Data from a bad HTTP response (upstream `CustomErrorData` shape).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="errordetails"></a> `errorDetails?` | `Record`\<`string`, `unknown`\>[] |
| <a id="response"></a> `response?` | `unknown` |
| <a id="status"></a> `status?` | `number` |
| <a id="statustext"></a> `statusText?` | `string` |

***

<a id="date"></a>

### Date

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="day"></a> `day` | `number` |
| <a id="month"></a> `month` | `number` |
| <a id="year"></a> `year` | `number` |

***

<a id="enhancedgeneratecontentresponse"></a>

### EnhancedGenerateContentResponse

#### Extends

- [`GenerateContentResponse`](#generatecontentresponse)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="candidates"></a> `candidates?` | [`GenerateContentCandidate`](#generatecontentcandidate)[] |
| <a id="promptfeedback"></a> `promptFeedback?` | [`PromptFeedback`](#promptfeedback-2) |
| <a id="usagemetadata"></a> `usageMetadata?` | [`UsageMetadata`](#usagemetadata-2) |

#### Methods

<a id="functioncalls"></a>

##### functionCalls()

```ts
functionCalls(): FunctionCall[];
```

###### Returns

[`FunctionCall`](#functioncall-3)[]

<a id="inlinedataparts"></a>

##### inlineDataParts()

```ts
inlineDataParts(): InlineDataPart[];
```

###### Returns

[`InlineDataPart`](#inlinedatapart)[]

<a id="text-1"></a>

##### text()

```ts
text(): string;
```

###### Returns

`string`

<a id="thoughtsummary"></a>

##### thoughtSummary()

```ts
thoughtSummary(): string;
```

###### Returns

`string`

***

<a id="errordetails-1"></a>

### ErrorDetails

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="type-8"></a> `@type?` | `string` |
| <a id="domain"></a> `domain?` | `string` |
| <a id="metadata"></a> `metadata?` | `Record`\<`string`, `unknown`\> |
| <a id="reason"></a> `reason?` | `string` |

***

<a id="executablecode-1"></a>

### ExecutableCode

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="code-1"></a> `code?` | `string` |
| <a id="language"></a> `language?` | `string` |

***

<a id="executablecodepart"></a>

### ExecutableCodePart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-2"></a> `codeExecutionResult?` | `never` |
| <a id="executablecode-2"></a> `executableCode?` | [`ExecutableCode`](#executablecode-1) |
| <a id="filedata-1"></a> `fileData` | `never` |
| <a id="functioncall-1"></a> `functionCall?` | `never` |
| <a id="functionresponse-1"></a> `functionResponse?` | `never` |
| <a id="inlinedata-1"></a> `inlineData?` | `never` |
| <a id="text-3"></a> `text?` | `never` |
| <a id="thought-1"></a> `thought?` | `never` |

***

<a id="filedata-2"></a>

### FileData

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="fileuri"></a> `fileUri` | `string` |
| <a id="mimetype"></a> `mimeType` | `string` |

***

<a id="filedatapart"></a>

### FileDataPart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-3"></a> `codeExecutionResult?` | `never` |
| <a id="executablecode-3"></a> `executableCode?` | `never` |
| <a id="filedata-3"></a> `fileData` | [`FileData`](#filedata-2) |
| <a id="functioncall-2"></a> `functionCall?` | `never` |
| <a id="functionresponse-2"></a> `functionResponse?` | `never` |
| <a id="inlinedata-2"></a> `inlineData?` | `never` |
| <a id="text-4"></a> `text?` | `never` |
| <a id="thought-2"></a> `thought?` | `boolean` |

***

<a id="functioncall-3"></a>

### FunctionCall

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="args"></a> `args` | `object` |
| <a id="id"></a> `id?` | `string` |
| <a id="name-1"></a> `name` | `string` |

***

<a id="functioncallingconfig"></a>

### FunctionCallingConfig

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="allowedfunctionnames"></a> `allowedFunctionNames?` | `string`[] |
| <a id="mode"></a> `mode?` | [`FunctionCallingMode`](#functioncallingmode) |

***

<a id="functioncallpart"></a>

### FunctionCallPart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-4"></a> `codeExecutionResult?` | `never` |
| <a id="executablecode-4"></a> `executableCode?` | `never` |
| <a id="functioncall-4"></a> `functionCall` | [`FunctionCall`](#functioncall-3) |
| <a id="functionresponse-3"></a> `functionResponse?` | `never` |
| <a id="inlinedata-3"></a> `inlineData?` | `never` |
| <a id="text-5"></a> `text?` | `never` |
| <a id="thought-3"></a> `thought?` | `boolean` |

***

<a id="functiondeclaration"></a>

### FunctionDeclaration

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="description"></a> `description` | `string` |
| <a id="functionreference"></a> `functionReference?` | `Function` |
| <a id="name-2"></a> `name` | `string` |
| <a id="parameters"></a> `parameters?` | `ObjectSchemaInstance` \| [`ObjectSchemaRequest`](#objectschemarequest) |

***

<a id="functiondeclarationstool"></a>

### FunctionDeclarationsTool

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="functiondeclarations"></a> `functionDeclarations?` | [`FunctionDeclaration`](#functiondeclaration)[] |

***

<a id="functionresponse-4"></a>

### FunctionResponse

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="id-1"></a> `id?` | `string` |
| <a id="name-3"></a> `name` | `string` |
| <a id="parts-1"></a> `parts?` | [`Part`](#part)[] |
| <a id="response-1"></a> `response` | `object` |

***

<a id="functionresponsepart"></a>

### FunctionResponsePart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-5"></a> `codeExecutionResult?` | `never` |
| <a id="executablecode-5"></a> `executableCode?` | `never` |
| <a id="functioncall-5"></a> `functionCall?` | `never` |
| <a id="functionresponse-5"></a> `functionResponse` | [`FunctionResponse`](#functionresponse-4) |
| <a id="inlinedata-4"></a> `inlineData?` | `never` |
| <a id="text-6"></a> `text?` | `never` |
| <a id="thought-4"></a> `thought?` | `boolean` |

***

<a id="generatecontentcandidate"></a>

### GenerateContentCandidate

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="citationmetadata-1"></a> `citationMetadata?` | [`CitationMetadata`](#citationmetadata) |
| <a id="content-1"></a> `content` | [`Content`](#content) |
| <a id="finishmessage"></a> `finishMessage?` | `string` |
| <a id="finishreason"></a> `finishReason?` | [`FinishReason`](#finishreason-1) |
| <a id="groundingmetadata"></a> `groundingMetadata?` | [`GroundingMetadata`](#groundingmetadata-1) |
| <a id="index"></a> `index` | `number` |
| <a id="safetyratings"></a> `safetyRatings?` | [`SafetyRating`](#safetyrating)[] |
| <a id="urlcontextmetadata"></a> `urlContextMetadata?` | [`URLContextMetadata`](#urlcontextmetadata-1) |

***

<a id="generatecontentrequest"></a>

### GenerateContentRequest

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="contents-1"></a> `contents` | [`Content`](#content)[] |
| <a id="generationconfig-3"></a> `generationConfig?` | [`GenerationConfig`](#generationconfig-4) |
| <a id="safetysettings-2"></a> `safetySettings?` | [`SafetySetting`](#safetysetting)[] |
| <a id="systeminstruction-2"></a> `systemInstruction?` | `string` \| [`Content`](#content) \| [`Part`](#part) |
| <a id="toolconfig-1"></a> `toolConfig?` | [`ToolConfig`](#toolconfig-4) |
| <a id="tools-2"></a> `tools?` | [`Tool`](#tool)[] |

***

<a id="generatecontentresponse"></a>

### GenerateContentResponse

#### Extended by

- [`EnhancedGenerateContentResponse`](#enhancedgeneratecontentresponse)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="candidates-1"></a> `candidates?` | [`GenerateContentCandidate`](#generatecontentcandidate)[] |
| <a id="promptfeedback-1"></a> `promptFeedback?` | [`PromptFeedback`](#promptfeedback-2) |
| <a id="usagemetadata-1"></a> `usageMetadata?` | [`UsageMetadata`](#usagemetadata-2) |

***

<a id="generatecontentresult"></a>

### GenerateContentResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="response-2"></a> `response` | `EnhancedResponse` |

***

<a id="generatecontentstreamresult"></a>

### GenerateContentStreamResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="response-3"></a> `response` | `Promise`\<`EnhancedResponse`\> |
| <a id="stream"></a> `stream` | `AsyncGenerator`\<`EnhancedResponse`\> |

***

<a id="generationconfig-4"></a>

### GenerationConfig

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="candidatecount"></a> `candidateCount?` | `number` |
| <a id="frequencypenalty"></a> `frequencyPenalty?` | `number` |
| <a id="imageconfig"></a> `imageConfig?` | [`ImageConfig`](#imageconfig-1) |
| <a id="maxoutputtokens"></a> `maxOutputTokens?` | `number` |
| <a id="presencepenalty"></a> `presencePenalty?` | `number` |
| <a id="responsejsonschema"></a> `responseJsonSchema?` | `Record`\<`string`, `unknown`\> |
| <a id="responsemimetype"></a> `responseMimeType?` | `string` |
| <a id="responsemodalities"></a> `responseModalities?` | [`ResponseModality`](#responsemodality)[] |
| <a id="responseschema"></a> `responseSchema?` | [`TypedSchema`](#typedschema) \| [`SchemaRequest`](#schemarequest) |
| <a id="stopsequences"></a> `stopSequences?` | `string`[] |
| <a id="temperature"></a> `temperature?` | `number` |
| <a id="thinkingconfig"></a> `thinkingConfig?` | [`ThinkingConfig`](#thinkingconfig-1) |
| <a id="topk"></a> `topK?` | `number` |
| <a id="topp"></a> `topP?` | `number` |

***

<a id="generativecontentblob"></a>

### GenerativeContentBlob

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data` | `string` |
| <a id="mimetype-1"></a> `mimeType` | `string` |

***

<a id="googlemaps"></a>

### GoogleMaps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="enablewidget"></a> `enableWidget?` | `boolean` |

***

<a id="googlemapsgroundingchunk"></a>

### GoogleMapsGroundingChunk

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="placeid"></a> `placeId?` | `string` |
| <a id="text-7"></a> `text?` | `string` |
| <a id="title-1"></a> `title?` | `string` |
| <a id="uri-1"></a> `uri?` | `string` |

***

<a id="googlemapstool"></a>

### GoogleMapsTool

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="googlemaps-1"></a> `googleMaps` | [`GoogleMaps`](#googlemaps) |

***

<a id="googlesearch"></a>

### GoogleSearch

***

<a id="googlesearchtool"></a>

### GoogleSearchTool

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="googlesearch-1"></a> `googleSearch` | [`GoogleSearch`](#googlesearch) |

***

<a id="groundingchunk"></a>

### GroundingChunk

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="maps"></a> `maps?` | [`GoogleMapsGroundingChunk`](#googlemapsgroundingchunk) |
| <a id="web"></a> `web?` | [`WebGroundingChunk`](#webgroundingchunk) |

***

<a id="groundingmetadata-1"></a>

### GroundingMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="googlemapswidgetcontexttoken"></a> `googleMapsWidgetContextToken?` | `string` |
| <a id="groundingchunks"></a> `groundingChunks?` | [`GroundingChunk`](#groundingchunk)[] |
| <a id="groundingsupports"></a> `groundingSupports?` | [`GroundingSupport`](#groundingsupport)[] |
| <a id="retrievalqueries"></a> `retrievalQueries?` | `string`[] |
| <a id="searchentrypoint"></a> `searchEntryPoint?` | [`SearchEntrypoint`](#searchentrypoint-1) |
| <a id="websearchqueries"></a> `webSearchQueries?` | `string`[] |

***

<a id="groundingsupport"></a>

### GroundingSupport

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="groundingchunkindices"></a> `groundingChunkIndices?` | `number`[] |
| <a id="segment"></a> `segment?` | [`Segment`](#segment-1) |

***

<a id="imageconfig-1"></a>

### ImageConfig

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="aspectratio"></a> `aspectRatio?` | [`ImageConfigAspectRatio`](#imageconfigaspectratio-1) |
| <a id="imagesize"></a> `imageSize?` | [`ImageConfigImageSize`](#imageconfigimagesize-1) |

***

<a id="inlinedatapart"></a>

### InlineDataPart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-6"></a> `codeExecutionResult?` | `never` |
| <a id="executablecode-6"></a> `executableCode?` | `never` |
| <a id="functioncall-6"></a> `functionCall?` | `never` |
| <a id="functionresponse-6"></a> `functionResponse?` | `never` |
| <a id="inlinedata-5"></a> `inlineData` | [`GenerativeContentBlob`](#generativecontentblob) |
| <a id="text-8"></a> `text?` | `never` |
| <a id="thought-5"></a> `thought?` | `boolean` |
| <a id="videometadata"></a> `videoMetadata?` | [`VideoMetadata`](#videometadata-1) |

***

<a id="latlng"></a>

### LatLng

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="latitude"></a> `latitude?` | `number` |
| <a id="longitude"></a> `longitude?` | `number` |

***

<a id="modalitytokencount"></a>

### ModalityTokenCount

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="modality"></a> `modality` | [`Modality`](#modality-1) |
| <a id="tokencount"></a> `tokenCount` | `number` |

***

<a id="modelparams"></a>

### ModelParams

#### Extends

- [`BaseParams`](#baseparams)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="generationconfig-5"></a> `generationConfig?` | `Record`\<`string`, `unknown`\> |
| <a id="model-3"></a> `model` | `string` |
| <a id="safetysettings-3"></a> `safetySettings?` | `unknown`[] |
| <a id="systeminstruction-3"></a> `systemInstruction?` | \| `string` \| `ContentShape` \| \{ `text?`: `string`; \} |
| <a id="toolconfig-2"></a> `toolConfig?` | `unknown` |
| <a id="tools-3"></a> `tools?` | `unknown`[] |

***

<a id="objectschemarequest"></a>

### ObjectSchemaRequest

#### Extends

- [`SchemaRequest`](#schemarequest)

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type | Overrides |
| :------ | :------ | :------ |
| <a id="anyof-17"></a> `anyOf?` | [`SchemaRequest`](#schemarequest)[] | - |
| <a id="description-1"></a> `description?` | `string` | - |
| <a id="enum-1"></a> `enum?` | `string`[] | - |
| <a id="example"></a> `example?` | `unknown` | - |
| <a id="format-8"></a> `format?` | `string` | - |
| <a id="items-1"></a> `items?` | [`SchemaRequest`](#schemarequest) | - |
| <a id="maximum"></a> `maximum?` | `number` | - |
| <a id="maxitems"></a> `maxItems?` | `number` | - |
| <a id="minimum"></a> `minimum?` | `number` | - |
| <a id="minitems"></a> `minItems?` | `number` | - |
| <a id="nullable-8"></a> `nullable?` | `boolean` | - |
| <a id="optionalproperties-1"></a> `optionalProperties?` | `never` | - |
| <a id="properties-1"></a> `properties?` | `Record`\<`string`, `T`\> | - |
| <a id="propertyordering"></a> `propertyOrdering?` | `string`[] | - |
| <a id="required"></a> `required?` | `string`[] | - |
| <a id="title-2"></a> `title?` | `string` | - |
| <a id="type-9"></a> `type` | `"object"` | [`SchemaRequest`](#schemarequest).[`type`](#type-12) |

***

<a id="promptfeedback-2"></a>

### PromptFeedback

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="blockreason"></a> `blockReason?` | [`BlockReason`](#blockreason-1) |
| <a id="blockreasonmessage"></a> `blockReasonMessage?` | `string` |
| <a id="safetyratings-1"></a> `safetyRatings` | [`SafetyRating`](#safetyrating)[] |

***

<a id="requestoptions-2"></a>

### RequestOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="baseurl"></a> `baseUrl?` | `string` |
| <a id="maxsequentialfunctioncalls"></a> `maxSequentialFunctionCalls?` | `number` |
| <a id="timeout"></a> `timeout?` | `number` |

***

<a id="retrievalconfig"></a>

### RetrievalConfig

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="languagecode"></a> `languageCode?` | `string` |
| <a id="latlng-1"></a> `latLng?` | [`LatLng`](#latlng) |

***

<a id="safetyrating"></a>

### SafetyRating

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="blocked"></a> `blocked` | `boolean` |
| <a id="category"></a> `category` | [`HarmCategory`](#harmcategory) |
| <a id="probability"></a> `probability` | [`HarmProbability`](#harmprobability) |
| <a id="probabilityscore"></a> `probabilityScore` | `number` |
| <a id="severity"></a> `severity` | [`HarmSeverity`](#harmseverity) |
| <a id="severityscore"></a> `severityScore` | `number` |

***

<a id="safetysetting"></a>

### SafetySetting

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="category-1"></a> `category` | [`HarmCategory`](#harmcategory) |
| <a id="method"></a> `method?` | [`HarmBlockMethod`](#harmblockmethod) |
| <a id="threshold"></a> `threshold` | [`HarmBlockThreshold`](#harmblockthreshold) |

***

<a id="schemainterface"></a>

### SchemaInterface

#### Extends

- [`SchemaShared`](#schemashared)\<[`SchemaInterface`](#schemainterface)\>

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="anyof-18"></a> `anyOf?` | [`SchemaInterface`](#schemainterface)[] |
| <a id="description-2"></a> `description?` | `string` |
| <a id="enum-2"></a> `enum?` | `string`[] |
| <a id="example-1"></a> `example?` | `unknown` |
| <a id="format-9"></a> `format?` | `string` |
| <a id="items-2"></a> `items?` | [`SchemaInterface`](#schemainterface) |
| <a id="maximum-1"></a> `maximum?` | `number` |
| <a id="maxitems-1"></a> `maxItems?` | `number` |
| <a id="minimum-1"></a> `minimum?` | `number` |
| <a id="minitems-1"></a> `minItems?` | `number` |
| <a id="nullable-9"></a> `nullable?` | `boolean` |
| <a id="properties-2"></a> `properties?` | `Record`\<`string`, `T`\> |
| <a id="propertyordering-1"></a> `propertyOrdering?` | `string`[] |
| <a id="title-3"></a> `title?` | `string` |
| <a id="type-10"></a> `type?` | [`SchemaType`](#schematype-1) |

***

<a id="schemaparams"></a>

### SchemaParams

Params accepted by the static builders (upstream `SchemaParams` shape).

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="anyof-19"></a> `anyOf?` | [`TypedSchema`](#typedschema)[] |
| <a id="description-3"></a> `description?` | `string` |
| <a id="enum-3"></a> `enum?` | `string`[] |
| <a id="example-2"></a> `example?` | `unknown` |
| <a id="format-10"></a> `format?` | `string` |
| <a id="items-3"></a> `items?` | [`Schema`](#schema) |
| <a id="maximum-2"></a> `maximum?` | `number` |
| <a id="maxitems-2"></a> `maxItems?` | `number` |
| <a id="minimum-2"></a> `minimum?` | `number` |
| <a id="minitems-2"></a> `minItems?` | `number` |
| <a id="nullable-10"></a> `nullable?` | `boolean` |
| <a id="optionalproperties-2"></a> `optionalProperties?` | `string`[] |
| <a id="properties-3"></a> `properties?` | `Record`\<`string`, [`Schema`](#schema)\> |
| <a id="propertyordering-2"></a> `propertyOrdering?` | `string`[] |
| <a id="title-4"></a> `title?` | `string` |
| <a id="type-11"></a> `type?` | [`SchemaType`](#schematype-1) |

***

<a id="schemarequest"></a>

### SchemaRequest

#### Extends

- [`SchemaShared`](#schemashared)\<[`SchemaRequest`](#schemarequest)\>

#### Extended by

- [`ObjectSchemaRequest`](#objectschemarequest)

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="anyof-20"></a> `anyOf?` | [`SchemaRequest`](#schemarequest)[] |
| <a id="description-4"></a> `description?` | `string` |
| <a id="enum-4"></a> `enum?` | `string`[] |
| <a id="example-3"></a> `example?` | `unknown` |
| <a id="format-11"></a> `format?` | `string` |
| <a id="items-4"></a> `items?` | [`SchemaRequest`](#schemarequest) |
| <a id="maximum-3"></a> `maximum?` | `number` |
| <a id="maxitems-3"></a> `maxItems?` | `number` |
| <a id="minimum-3"></a> `minimum?` | `number` |
| <a id="minitems-3"></a> `minItems?` | `number` |
| <a id="nullable-11"></a> `nullable?` | `boolean` |
| <a id="properties-4"></a> `properties?` | `Record`\<`string`, `T`\> |
| <a id="propertyordering-3"></a> `propertyOrdering?` | `string`[] |
| <a id="required-1"></a> `required?` | `string`[] |
| <a id="title-5"></a> `title?` | `string` |
| <a id="type-12"></a> `type?` | [`SchemaType`](#schematype-1) |

***

<a id="schemashared"></a>

### SchemaShared

#### Extended by

- [`SchemaInterface`](#schemainterface)
- [`SchemaRequest`](#schemarequest)

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="anyof-21"></a> `anyOf?` | `T`[] |
| <a id="description-5"></a> `description?` | `string` |
| <a id="enum-5"></a> `enum?` | `string`[] |
| <a id="example-4"></a> `example?` | `unknown` |
| <a id="format-12"></a> `format?` | `string` |
| <a id="items-5"></a> `items?` | `T` |
| <a id="maximum-4"></a> `maximum?` | `number` |
| <a id="maxitems-4"></a> `maxItems?` | `number` |
| <a id="minimum-4"></a> `minimum?` | `number` |
| <a id="minitems-4"></a> `minItems?` | `number` |
| <a id="nullable-12"></a> `nullable?` | `boolean` |
| <a id="properties-5"></a> `properties?` | `Record`\<`string`, `T`\> |
| <a id="propertyordering-4"></a> `propertyOrdering?` | `string`[] |
| <a id="title-6"></a> `title?` | `string` |

***

<a id="searchentrypoint-1"></a>

### SearchEntrypoint

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="renderedcontent"></a> `renderedContent?` | `string` |

***

<a id="segment-1"></a>

### Segment

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="endindex-1"></a> `endIndex` | `number` |
| <a id="partindex"></a> `partIndex` | `number` |
| <a id="startindex-1"></a> `startIndex` | `number` |
| <a id="text-9"></a> `text` | `string` |

***

<a id="singlerequestoptions"></a>

### SingleRequestOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="baseurl-1"></a> `baseUrl?` | `string` |
| <a id="maxsequentialfunctioncalls-1"></a> `maxSequentialFunctionCalls?` | `number` |
| <a id="signal"></a> `signal?` | `AbortSignal` |
| <a id="timeout-1"></a> `timeout?` | `number` |

***

<a id="startchatparams"></a>

### StartChatParams

#### Extends

- [`BaseParams`](#baseparams)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="generationconfig-6"></a> `generationConfig?` | `Record`\<`string`, `unknown`\> |
| <a id="history"></a> `history?` | `ContentShape`[] |
| <a id="safetysettings-4"></a> `safetySettings?` | `unknown`[] |
| <a id="systeminstruction-4"></a> `systemInstruction?` | \| `string` \| `ContentShape` \| \{ `text?`: `string`; \} |
| <a id="toolconfig-3"></a> `toolConfig?` | `unknown` |
| <a id="tools-4"></a> `tools?` | `unknown`[] |

***

<a id="textpart"></a>

### TextPart

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="codeexecutionresult-7"></a> `codeExecutionResult?` | `never` |
| <a id="executablecode-7"></a> `executableCode?` | `never` |
| <a id="functioncall-7"></a> `functionCall?` | `never` |
| <a id="functionresponse-7"></a> `functionResponse?` | `never` |
| <a id="inlinedata-6"></a> `inlineData?` | `never` |
| <a id="text-10"></a> `text` | `string` |
| <a id="thought-6"></a> `thought?` | `boolean` |

***

<a id="thinkingconfig-1"></a>

### ThinkingConfig

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="includethoughts"></a> `includeThoughts?` | `boolean` |
| <a id="thinkingbudget"></a> `thinkingBudget?` | `number` |
| <a id="thinkinglevel"></a> `thinkingLevel?` | `string` |

***

<a id="toolconfig-4"></a>

### ToolConfig

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="functioncallingconfig-1"></a> `functionCallingConfig?` | [`FunctionCallingConfig`](#functioncallingconfig) |
| <a id="retrievalconfig-1"></a> `retrievalConfig?` | [`RetrievalConfig`](#retrievalconfig) |

***

<a id="urlcontext"></a>

### URLContext

***

<a id="urlcontextmetadata-1"></a>

### URLContextMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="urlmetadata"></a> `urlMetadata` | [`URLMetadata`](#urlmetadata-1)[] |

***

<a id="urlcontexttool"></a>

### URLContextTool

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="urlcontext-1"></a> `urlContext` | [`URLContext`](#urlcontext) |

***

<a id="urlmetadata-1"></a>

### URLMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="retrievedurl"></a> `retrievedUrl?` | `string` |
| <a id="urlretrievalstatus"></a> `urlRetrievalStatus?` | `string` |

***

<a id="usagemetadata-2"></a>

### UsageMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cachedcontenttokencount"></a> `cachedContentTokenCount?` | `number` |
| <a id="cachetokensdetails"></a> `cacheTokensDetails?` | [`ModalityTokenCount`](#modalitytokencount)[] |
| <a id="candidatestokencount"></a> `candidatesTokenCount` | `number` |
| <a id="candidatestokensdetails"></a> `candidatesTokensDetails?` | [`ModalityTokenCount`](#modalitytokencount)[] |
| <a id="prompttokencount"></a> `promptTokenCount` | `number` |
| <a id="prompttokensdetails-1"></a> `promptTokensDetails?` | [`ModalityTokenCount`](#modalitytokencount)[] |
| <a id="thoughtstokencount"></a> `thoughtsTokenCount?` | `number` |
| <a id="tooluseprompttokencount"></a> `toolUsePromptTokenCount?` | `number` |
| <a id="tooluseprompttokensdetails"></a> `toolUsePromptTokensDetails?` | [`ModalityTokenCount`](#modalitytokencount)[] |
| <a id="totaltokencount"></a> `totalTokenCount` | `number` |

***

<a id="videometadata-1"></a>

### VideoMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="endoffset"></a> `endOffset` | `string` |
| <a id="startoffset"></a> `startOffset` | `string` |

***

<a id="webgroundingchunk"></a>

### WebGroundingChunk

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="domain-1"></a> `domain?` | `string` |
| <a id="title-7"></a> `title?` | `string` |
| <a id="uri-2"></a> `uri?` | `string` |

## Type Aliases

<a id="aierrorcode-1"></a>

### AIErrorCode

```ts
type AIErrorCode = typeof AIErrorCode[keyof typeof AIErrorCode];
```

`pyric/ai` — modular Web-SDK AI adapter for the Pyric sandbox.

Mirrors the admitted `firebase/ai` surface as a sandbox-only adapter.
Availability and reviewed dispositions are owned only by
`packages/conformance/surfaces/ai.json`; this barrel deliberately carries
no copied counts or deny-list. Production selection happens before it loads:
unmodified `firebase/ai` imports either remain Firebase or are swapped to
this package by the Vite/import-map or Node register boundary.

  - **Sandbox target** — `getAI(sandbox)` answers in-process through the
    AiBroker answer-engine seam (`scripted` default: zero-config,
    zero-I/O, deterministic; or `openai`: any OpenAI-compatible upstream).
    Scripting lives on the `pyric/ai/scripting` subpath.
A [TARGET\_SYMBOL](#target_symbol) brand binds every [AI](#ai) handle to its sandbox
broker. There is no production target or runtime Firebase dispatch here.

***

<a id="backendtype-3"></a>

### BackendType

```ts
type BackendType = typeof BackendType[keyof typeof BackendType];
```

***

<a id="blockreason-1"></a>

### BlockReason

```ts
type BlockReason = typeof BlockReason[keyof typeof BlockReason];
```

***

<a id="finishreason-1"></a>

### FinishReason

```ts
type FinishReason = typeof FinishReason[keyof typeof FinishReason];
```

***

<a id="functioncallingmode"></a>

### FunctionCallingMode

```ts
type FunctionCallingMode = typeof FunctionCallingMode[keyof typeof FunctionCallingMode];
```

***

<a id="harmblockmethod"></a>

### HarmBlockMethod

```ts
type HarmBlockMethod = typeof HarmBlockMethod[keyof typeof HarmBlockMethod];
```

***

<a id="harmblockthreshold"></a>

### HarmBlockThreshold

```ts
type HarmBlockThreshold = typeof HarmBlockThreshold[keyof typeof HarmBlockThreshold];
```

***

<a id="harmcategory"></a>

### HarmCategory

```ts
type HarmCategory = typeof HarmCategory[keyof typeof HarmCategory];
```

***

<a id="harmprobability"></a>

### HarmProbability

```ts
type HarmProbability = typeof HarmProbability[keyof typeof HarmProbability];
```

***

<a id="harmseverity"></a>

### HarmSeverity

```ts
type HarmSeverity = typeof HarmSeverity[keyof typeof HarmSeverity];
```

***

<a id="imageconfigaspectratio-1"></a>

### ImageConfigAspectRatio

```ts
type ImageConfigAspectRatio = typeof ImageConfigAspectRatio[keyof typeof ImageConfigAspectRatio];
```

***

<a id="imageconfigimagesize-1"></a>

### ImageConfigImageSize

```ts
type ImageConfigImageSize = typeof ImageConfigImageSize[keyof typeof ImageConfigImageSize];
```

***

<a id="language-1"></a>

### Language

```ts
type Language = typeof Language[keyof typeof Language];
```

***

<a id="modality-1"></a>

### Modality

```ts
type Modality = typeof Modality[keyof typeof Modality];
```

***

<a id="outcome-1"></a>

### Outcome

```ts
type Outcome = typeof Outcome[keyof typeof Outcome];
```

***

<a id="part"></a>

### Part

```ts
type Part =
  | TextPart
  | InlineDataPart
  | FunctionCallPart
  | FunctionResponsePart
  | FileDataPart
  | ExecutableCodePart
  | CodeExecutionResultPart;
```

***

<a id="responsemodality"></a>

### ResponseModality

```ts
type ResponseModality = typeof ResponseModality[keyof typeof ResponseModality];
```

***

<a id="role-1"></a>

### Role

```ts
type Role = typeof POSSIBLE_ROLES[number];
```

The producer of the content.

***

<a id="schematype-1"></a>

### SchemaType

```ts
type SchemaType = typeof SchemaType[keyof typeof SchemaType];
```

***

<a id="thinkinglevel-1"></a>

### ThinkingLevel

```ts
type ThinkingLevel = typeof ThinkingLevel[keyof typeof ThinkingLevel];
```

***

<a id="tool"></a>

### Tool

```ts
type Tool =
  | FunctionDeclarationsTool
  | GoogleMapsTool
  | GoogleSearchTool
  | CodeExecutionTool
  | URLContextTool;
```

***

<a id="typedschema"></a>

### TypedSchema

```ts
type TypedSchema =
  | IntegerSchema
  | NumberSchema
  | StringSchema
  | BooleanSchema
  | ObjectSchema
  | ArraySchema
  | AnyOfSchema;
```

Union of all concrete schema classes.

***

<a id="urlretrievalstatus-1"></a>

### URLRetrievalStatus

```ts
type URLRetrievalStatus = typeof URLRetrievalStatus[keyof typeof URLRetrievalStatus];
```

## Variables

<a id="aierrorcode-2"></a>

### AIErrorCode

```ts
const AIErrorCode: {
  API_NOT_ENABLED: "api-not-enabled";
  ERROR: "error";
  FETCH_ERROR: "fetch-error";
  INVALID_CONTENT: "invalid-content";
  INVALID_SCHEMA: "invalid-schema";
  NO_API_KEY: "no-api-key";
  NO_APP_ID: "no-app-id";
  NO_MODEL: "no-model";
  NO_PROJECT_ID: "no-project-id";
  PARSE_FAILED: "parse-failed";
  REQUEST_ERROR: "request-error";
  RESPONSE_ERROR: "response-error";
  SESSION_CLOSED: "session-closed";
  UNSUPPORTED: "unsupported";
};
```

Standardized error codes the SDK can throw — 14 codes in 2.12.0.

#### Type Declaration

<a id="api_not_enabled"></a>

##### API\_NOT\_ENABLED

```ts
readonly API_NOT_ENABLED: "api-not-enabled";
```

<a id="error"></a>

##### ERROR

```ts
readonly ERROR: "error";
```

<a id="fetch_error"></a>

##### FETCH\_ERROR

```ts
readonly FETCH_ERROR: "fetch-error";
```

<a id="invalid_content"></a>

##### INVALID\_CONTENT

```ts
readonly INVALID_CONTENT: "invalid-content";
```

<a id="invalid_schema"></a>

##### INVALID\_SCHEMA

```ts
readonly INVALID_SCHEMA: "invalid-schema";
```

<a id="no_api_key"></a>

##### NO\_API\_KEY

```ts
readonly NO_API_KEY: "no-api-key";
```

<a id="no_app_id"></a>

##### NO\_APP\_ID

```ts
readonly NO_APP_ID: "no-app-id";
```

<a id="no_model"></a>

##### NO\_MODEL

```ts
readonly NO_MODEL: "no-model";
```

<a id="no_project_id"></a>

##### NO\_PROJECT\_ID

```ts
readonly NO_PROJECT_ID: "no-project-id";
```

<a id="parse_failed"></a>

##### PARSE\_FAILED

```ts
readonly PARSE_FAILED: "parse-failed";
```

<a id="request_error"></a>

##### REQUEST\_ERROR

```ts
readonly REQUEST_ERROR: "request-error";
```

<a id="response_error"></a>

##### RESPONSE\_ERROR

```ts
readonly RESPONSE_ERROR: "response-error";
```

<a id="session_closed"></a>

##### SESSION\_CLOSED

```ts
readonly SESSION_CLOSED: "session-closed";
```

<a id="unsupported"></a>

##### UNSUPPORTED

```ts
readonly UNSUPPORTED: "unsupported";
```

***

<a id="backendtype-4"></a>

### BackendType

```ts
const BackendType: {
  GOOGLE_AI: "GOOGLE_AI";
  VERTEX_AI: "VERTEX_AI";
};
```

Identifies which backend service the SDK communicates with.

#### Type Declaration

<a id="google_ai"></a>

##### GOOGLE\_AI

```ts
readonly GOOGLE_AI: "GOOGLE_AI";
```

<a id="vertex_ai"></a>

##### VERTEX\_AI

```ts
readonly VERTEX_AI: "VERTEX_AI";
```

***

<a id="blockreason-2"></a>

### BlockReason

```ts
const BlockReason: {
  BLOCKLIST: "BLOCKLIST";
  OTHER: "OTHER";
  PROHIBITED_CONTENT: "PROHIBITED_CONTENT";
  SAFETY: "SAFETY";
};
```

Reason that a prompt was blocked.

#### Type Declaration

<a id="blocklist"></a>

##### BLOCKLIST

```ts
readonly BLOCKLIST: "BLOCKLIST";
```

<a id="other"></a>

##### OTHER

```ts
readonly OTHER: "OTHER";
```

<a id="prohibited_content"></a>

##### PROHIBITED\_CONTENT

```ts
readonly PROHIBITED_CONTENT: "PROHIBITED_CONTENT";
```

<a id="safety"></a>

##### SAFETY

```ts
readonly SAFETY: "SAFETY";
```

***

<a id="finishreason-2"></a>

### FinishReason

```ts
const FinishReason: {
  BLOCKLIST: "BLOCKLIST";
  IMAGE_OTHER: "IMAGE_OTHER";
  IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT";
  IMAGE_RECITATION: "IMAGE_RECITATION";
  IMAGE_SAFETY: "IMAGE_SAFETY";
  LANGUAGE: "LANGUAGE";
  MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL";
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE";
  MAX_TOKENS: "MAX_TOKENS";
  MISSING_THOUGHT_SIGNATURE: "MISSING_THOUGHT_SIGNATURE";
  NO_IMAGE: "NO_IMAGE";
  OTHER: "OTHER";
  PROHIBITED_CONTENT: "PROHIBITED_CONTENT";
  RECITATION: "RECITATION";
  SAFETY: "SAFETY";
  SPII: "SPII";
  STOP: "STOP";
  TOO_MANY_TOOL_CALLS: "TOO_MANY_TOOL_CALLS";
  UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL";
};
```

Reason that a candidate run stopped generating tokens (19 values in 2.12.0).

#### Type Declaration

<a id="blocklist-1"></a>

##### BLOCKLIST

```ts
readonly BLOCKLIST: "BLOCKLIST";
```

<a id="image_other"></a>

##### IMAGE\_OTHER

```ts
readonly IMAGE_OTHER: "IMAGE_OTHER";
```

<a id="image_prohibited_content"></a>

##### IMAGE\_PROHIBITED\_CONTENT

```ts
readonly IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT";
```

<a id="image_recitation"></a>

##### IMAGE\_RECITATION

```ts
readonly IMAGE_RECITATION: "IMAGE_RECITATION";
```

<a id="image_safety"></a>

##### IMAGE\_SAFETY

```ts
readonly IMAGE_SAFETY: "IMAGE_SAFETY";
```

<a id="language-2"></a>

##### LANGUAGE

```ts
readonly LANGUAGE: "LANGUAGE";
```

<a id="malformed_function_call"></a>

##### MALFORMED\_FUNCTION\_CALL

```ts
readonly MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL";
```

<a id="malformed_response"></a>

##### MALFORMED\_RESPONSE

```ts
readonly MALFORMED_RESPONSE: "MALFORMED_RESPONSE";
```

<a id="max_tokens"></a>

##### MAX\_TOKENS

```ts
readonly MAX_TOKENS: "MAX_TOKENS";
```

<a id="missing_thought_signature"></a>

##### MISSING\_THOUGHT\_SIGNATURE

```ts
readonly MISSING_THOUGHT_SIGNATURE: "MISSING_THOUGHT_SIGNATURE";
```

<a id="no_image"></a>

##### NO\_IMAGE

```ts
readonly NO_IMAGE: "NO_IMAGE";
```

<a id="other-1"></a>

##### OTHER

```ts
readonly OTHER: "OTHER";
```

<a id="prohibited_content-1"></a>

##### PROHIBITED\_CONTENT

```ts
readonly PROHIBITED_CONTENT: "PROHIBITED_CONTENT";
```

<a id="recitation"></a>

##### RECITATION

```ts
readonly RECITATION: "RECITATION";
```

<a id="safety-1"></a>

##### SAFETY

```ts
readonly SAFETY: "SAFETY";
```

<a id="spii"></a>

##### SPII

```ts
readonly SPII: "SPII";
```

<a id="stop"></a>

##### STOP

```ts
readonly STOP: "STOP";
```

<a id="too_many_tool_calls"></a>

##### TOO\_MANY\_TOOL\_CALLS

```ts
readonly TOO_MANY_TOOL_CALLS: "TOO_MANY_TOOL_CALLS";
```

<a id="unexpected_tool_call"></a>

##### UNEXPECTED\_TOOL\_CALL

```ts
readonly UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL";
```

***

<a id="functioncallingmode-1"></a>

### FunctionCallingMode

```ts
const FunctionCallingMode: {
  ANY: "ANY";
  AUTO: "AUTO";
  NONE: "NONE";
};
```

How the model may call functions: default, forced call, or no calls.

#### Type Declaration

<a id="any"></a>

##### ANY

```ts
readonly ANY: "ANY";
```

<a id="auto"></a>

##### AUTO

```ts
readonly AUTO: "AUTO";
```

<a id="none"></a>

##### NONE

```ts
readonly NONE: "NONE";
```

***

<a id="harmblockmethod-1"></a>

### HarmBlockMethod

```ts
const HarmBlockMethod: {
  PROBABILITY: "PROBABILITY";
  SEVERITY: "SEVERITY";
};
```

Probability-vs-severity blocking method (Vertex AI only).

#### Type Declaration

<a id="probability-1"></a>

##### PROBABILITY

```ts
readonly PROBABILITY: "PROBABILITY";
```

<a id="severity-1"></a>

##### SEVERITY

```ts
readonly SEVERITY: "SEVERITY";
```

***

<a id="harmblockthreshold-1"></a>

### HarmBlockThreshold

```ts
const HarmBlockThreshold: {
  BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE";
  BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE";
  BLOCK_NONE: "BLOCK_NONE";
  BLOCK_ONLY_HIGH: "BLOCK_ONLY_HIGH";
  OFF: "OFF";
};
```

Threshold above which a prompt or candidate will be blocked.

#### Type Declaration

<a id="block_low_and_above"></a>

##### BLOCK\_LOW\_AND\_ABOVE

```ts
readonly BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE";
```

<a id="block_medium_and_above"></a>

##### BLOCK\_MEDIUM\_AND\_ABOVE

```ts
readonly BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE";
```

<a id="block_none"></a>

##### BLOCK\_NONE

```ts
readonly BLOCK_NONE: "BLOCK_NONE";
```

<a id="block_only_high"></a>

##### BLOCK\_ONLY\_HIGH

```ts
readonly BLOCK_ONLY_HIGH: "BLOCK_ONLY_HIGH";
```

<a id="off"></a>

##### OFF

```ts
readonly OFF: "OFF";
```

***

<a id="harmcategory-1"></a>

### HarmCategory

```ts
const HarmCategory: {
  HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT";
  HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT";
  HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH";
  HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT";
};
```

Harm categories that would cause prompts or candidates to be blocked.

#### Type Declaration

<a id="harm_category_dangerous_content"></a>

##### HARM\_CATEGORY\_DANGEROUS\_CONTENT

```ts
readonly HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT";
```

<a id="harm_category_harassment"></a>

##### HARM\_CATEGORY\_HARASSMENT

```ts
readonly HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT";
```

<a id="harm_category_hate_speech"></a>

##### HARM\_CATEGORY\_HATE\_SPEECH

```ts
readonly HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH";
```

<a id="harm_category_sexually_explicit"></a>

##### HARM\_CATEGORY\_SEXUALLY\_EXPLICIT

```ts
readonly HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT";
```

***

<a id="harmprobability-1"></a>

### HarmProbability

```ts
const HarmProbability: {
  HIGH: "HIGH";
  LOW: "LOW";
  MEDIUM: "MEDIUM";
  NEGLIGIBLE: "NEGLIGIBLE";
};
```

Probability that a prompt or candidate matches a harm category.

#### Type Declaration

<a id="high"></a>

##### HIGH

```ts
readonly HIGH: "HIGH";
```

<a id="low"></a>

##### LOW

```ts
readonly LOW: "LOW";
```

<a id="medium"></a>

##### MEDIUM

```ts
readonly MEDIUM: "MEDIUM";
```

<a id="negligible"></a>

##### NEGLIGIBLE

```ts
readonly NEGLIGIBLE: "NEGLIGIBLE";
```

***

<a id="harmseverity-1"></a>

### HarmSeverity

```ts
const HarmSeverity: {
  HARM_SEVERITY_HIGH: "HARM_SEVERITY_HIGH";
  HARM_SEVERITY_LOW: "HARM_SEVERITY_LOW";
  HARM_SEVERITY_MEDIUM: "HARM_SEVERITY_MEDIUM";
  HARM_SEVERITY_NEGLIGIBLE: "HARM_SEVERITY_NEGLIGIBLE";
  HARM_SEVERITY_UNSUPPORTED: "HARM_SEVERITY_UNSUPPORTED";
};
```

Harm severity levels (`UNSUPPORTED` is the GoogleAI fallback).

#### Type Declaration

<a id="harm_severity_high"></a>

##### HARM\_SEVERITY\_HIGH

```ts
readonly HARM_SEVERITY_HIGH: "HARM_SEVERITY_HIGH";
```

<a id="harm_severity_low"></a>

##### HARM\_SEVERITY\_LOW

```ts
readonly HARM_SEVERITY_LOW: "HARM_SEVERITY_LOW";
```

<a id="harm_severity_medium"></a>

##### HARM\_SEVERITY\_MEDIUM

```ts
readonly HARM_SEVERITY_MEDIUM: "HARM_SEVERITY_MEDIUM";
```

<a id="harm_severity_negligible"></a>

##### HARM\_SEVERITY\_NEGLIGIBLE

```ts
readonly HARM_SEVERITY_NEGLIGIBLE: "HARM_SEVERITY_NEGLIGIBLE";
```

<a id="harm_severity_unsupported"></a>

##### HARM\_SEVERITY\_UNSUPPORTED

```ts
readonly HARM_SEVERITY_UNSUPPORTED: "HARM_SEVERITY_UNSUPPORTED";
```

***

<a id="imageconfigaspectratio-2"></a>

### ImageConfigAspectRatio

```ts
const ImageConfigAspectRatio: {
  LANDSCAPE_16x9: "16:9";
  LANDSCAPE_3x2: "3:2";
  LANDSCAPE_4x1: "4:1";
  LANDSCAPE_4x3: "4:3";
  LANDSCAPE_5x4: "5:4";
  LANDSCAPE_8x1: "8:1";
  PORTRAIT_1x4: "1:4";
  PORTRAIT_1x8: "1:8";
  PORTRAIT_2x3: "2:3";
  PORTRAIT_3x4: "3:4";
  PORTRAIT_4x5: "4:5";
  PORTRAIT_9x16: "9:16";
  SQUARE_1x1: "1:1";
  ULTRAWIDE_21x9: "21:9";
};
```

Aspect ratios for Gemini image generation (`ImageConfig.aspectRatio`).

#### Type Declaration

<a id="landscape_16x9"></a>

##### LANDSCAPE\_16x9

```ts
readonly LANDSCAPE_16x9: "16:9";
```

<a id="landscape_3x2"></a>

##### LANDSCAPE\_3x2

```ts
readonly LANDSCAPE_3x2: "3:2";
```

<a id="landscape_4x1"></a>

##### LANDSCAPE\_4x1

```ts
readonly LANDSCAPE_4x1: "4:1";
```

<a id="landscape_4x3"></a>

##### LANDSCAPE\_4x3

```ts
readonly LANDSCAPE_4x3: "4:3";
```

<a id="landscape_5x4"></a>

##### LANDSCAPE\_5x4

```ts
readonly LANDSCAPE_5x4: "5:4";
```

<a id="landscape_8x1"></a>

##### LANDSCAPE\_8x1

```ts
readonly LANDSCAPE_8x1: "8:1";
```

<a id="portrait_1x4"></a>

##### PORTRAIT\_1x4

```ts
readonly PORTRAIT_1x4: "1:4";
```

<a id="portrait_1x8"></a>

##### PORTRAIT\_1x8

```ts
readonly PORTRAIT_1x8: "1:8";
```

<a id="portrait_2x3"></a>

##### PORTRAIT\_2x3

```ts
readonly PORTRAIT_2x3: "2:3";
```

<a id="portrait_3x4"></a>

##### PORTRAIT\_3x4

```ts
readonly PORTRAIT_3x4: "3:4";
```

<a id="portrait_4x5"></a>

##### PORTRAIT\_4x5

```ts
readonly PORTRAIT_4x5: "4:5";
```

<a id="portrait_9x16"></a>

##### PORTRAIT\_9x16

```ts
readonly PORTRAIT_9x16: "9:16";
```

<a id="square_1x1"></a>

##### SQUARE\_1x1

```ts
readonly SQUARE_1x1: "1:1";
```

<a id="ultrawide_21x9"></a>

##### ULTRAWIDE\_21x9

```ts
readonly ULTRAWIDE_21x9: "21:9";
```

***

<a id="imageconfigimagesize-2"></a>

### ImageConfigImageSize

```ts
const ImageConfigImageSize: {
  SIZE_1K: "1K";
  SIZE_2K: "2K";
  SIZE_4K: "4K";
  SIZE_512: "512";
};
```

Sizes for Gemini generated images (`ImageConfig.imageSize`).

#### Type Declaration

<a id="size_1k"></a>

##### SIZE\_1K

```ts
readonly SIZE_1K: "1K";
```

<a id="size_2k"></a>

##### SIZE\_2K

```ts
readonly SIZE_2K: "2K";
```

<a id="size_4k"></a>

##### SIZE\_4K

```ts
readonly SIZE_4K: "4K";
```

<a id="size_512"></a>

##### SIZE\_512

```ts
readonly SIZE_512: "512";
```

***

<a id="language-3"></a>

### Language

```ts
const Language: {
  PYTHON: "PYTHON";
  UNSPECIFIED: "LANGUAGE_UNSPECIFIED";
};
```

Programming language of code the model executed.

#### Type Declaration

<a id="python"></a>

##### PYTHON

```ts
readonly PYTHON: "PYTHON";
```

<a id="unspecified"></a>

##### UNSPECIFIED

```ts
readonly UNSPECIFIED: "LANGUAGE_UNSPECIFIED";
```

***

<a id="modality-2"></a>

### Modality

```ts
const Modality: {
  AUDIO: "AUDIO";
  DOCUMENT: "DOCUMENT";
  IMAGE: "IMAGE";
  MODALITY_UNSPECIFIED: "MODALITY_UNSPECIFIED";
  TEXT: "TEXT";
  VIDEO: "VIDEO";
};
```

Content part modality.

#### Type Declaration

<a id="audio"></a>

##### AUDIO

```ts
readonly AUDIO: "AUDIO";
```

<a id="document"></a>

##### DOCUMENT

```ts
readonly DOCUMENT: "DOCUMENT";
```

<a id="image"></a>

##### IMAGE

```ts
readonly IMAGE: "IMAGE";
```

<a id="modality_unspecified"></a>

##### MODALITY\_UNSPECIFIED

```ts
readonly MODALITY_UNSPECIFIED: "MODALITY_UNSPECIFIED";
```

<a id="text-11"></a>

##### TEXT

```ts
readonly TEXT: "TEXT";
```

<a id="video"></a>

##### VIDEO

```ts
readonly VIDEO: "VIDEO";
```

***

<a id="outcome-2"></a>

### Outcome

```ts
const Outcome: {
  DEADLINE_EXCEEDED: "OUTCOME_DEADLINE_EXCEEDED";
  FAILED: "OUTCOME_FAILED";
  OK: "OUTCOME_OK";
  UNSPECIFIED: "OUTCOME_UNSPECIFIED";
};
```

Result of code the model ran.

#### Type Declaration

<a id="deadline_exceeded"></a>

##### DEADLINE\_EXCEEDED

```ts
readonly DEADLINE_EXCEEDED: "OUTCOME_DEADLINE_EXCEEDED";
```

<a id="failed"></a>

##### FAILED

```ts
readonly FAILED: "OUTCOME_FAILED";
```

<a id="ok"></a>

##### OK

```ts
readonly OK: "OUTCOME_OK";
```

<a id="unspecified-1"></a>

##### UNSPECIFIED

```ts
readonly UNSPECIFIED: "OUTCOME_UNSPECIFIED";
```

***

<a id="possible_roles"></a>

### POSSIBLE\_ROLES

```ts
const POSSIBLE_ROLES: readonly ["user", "model", "function", "system"];
```

Possible roles (upstream `POSSIBLE_ROLES`).

***

<a id="responsemodality-1"></a>

### ResponseModality

```ts
const ResponseModality: {
  AUDIO: "AUDIO";
  IMAGE: "IMAGE";
  TEXT: "TEXT";
};
```

Generation modalities in responses.

#### Type Declaration

<a id="audio-1"></a>

##### AUDIO

```ts
readonly AUDIO: "AUDIO";
```

<a id="image-1"></a>

##### IMAGE

```ts
readonly IMAGE: "IMAGE";
```

<a id="text-12"></a>

##### TEXT

```ts
readonly TEXT: "TEXT";
```

***

<a id="schematype-2"></a>

### SchemaType

```ts
const SchemaType: {
  ARRAY: "array";
  BOOLEAN: "boolean";
  INTEGER: "integer";
  NUMBER: "number";
  OBJECT: "object";
  STRING: "string";
};
```

OpenAPI data types for `Schema`.

#### Type Declaration

<a id="array-16"></a>

##### ARRAY

```ts
readonly ARRAY: "array";
```

<a id="boolean-16"></a>

##### BOOLEAN

```ts
readonly BOOLEAN: "boolean";
```

<a id="integer-16"></a>

##### INTEGER

```ts
readonly INTEGER: "integer";
```

<a id="number-16"></a>

##### NUMBER

```ts
readonly NUMBER: "number";
```

<a id="object-16"></a>

##### OBJECT

```ts
readonly OBJECT: "object";
```

<a id="string-16"></a>

##### STRING

```ts
readonly STRING: "string";
```

***

<a id="target_symbol"></a>

### TARGET\_SYMBOL

```ts
const TARGET_SYMBOL: unique symbol;
```

***

<a id="thinkinglevel-2"></a>

### ThinkingLevel

```ts
const ThinkingLevel: {
  HIGH: "HIGH";
  LOW: "LOW";
  MEDIUM: "MEDIUM";
  MINIMAL: "MINIMAL";
};
```

Preset controlling the thinking process of compatible models.

#### Type Declaration

<a id="high-1"></a>

##### HIGH

```ts
readonly HIGH: "HIGH";
```

<a id="low-1"></a>

##### LOW

```ts
readonly LOW: "LOW";
```

<a id="medium-1"></a>

##### MEDIUM

```ts
readonly MEDIUM: "MEDIUM";
```

<a id="minimal"></a>

##### MINIMAL

```ts
readonly MINIMAL: "MINIMAL";
```

***

<a id="urlretrievalstatus-2"></a>

### URLRetrievalStatus

```ts
const URLRetrievalStatus: {
  URL_RETRIEVAL_STATUS_ERROR: "URL_RETRIEVAL_STATUS_ERROR";
  URL_RETRIEVAL_STATUS_PAYWALL: "URL_RETRIEVAL_STATUS_PAYWALL";
  URL_RETRIEVAL_STATUS_SUCCESS: "URL_RETRIEVAL_STATUS_SUCCESS";
  URL_RETRIEVAL_STATUS_UNSAFE: "URL_RETRIEVAL_STATUS_UNSAFE";
  URL_RETRIEVAL_STATUS_UNSPECIFIED: "URL_RETRIEVAL_STATUS_UNSPECIFIED";
};
```

Status of a URL retrieval.

#### Type Declaration

<a id="url_retrieval_status_error"></a>

##### URL\_RETRIEVAL\_STATUS\_ERROR

```ts
readonly URL_RETRIEVAL_STATUS_ERROR: "URL_RETRIEVAL_STATUS_ERROR";
```

<a id="url_retrieval_status_paywall"></a>

##### URL\_RETRIEVAL\_STATUS\_PAYWALL

```ts
readonly URL_RETRIEVAL_STATUS_PAYWALL: "URL_RETRIEVAL_STATUS_PAYWALL";
```

<a id="url_retrieval_status_success"></a>

##### URL\_RETRIEVAL\_STATUS\_SUCCESS

```ts
readonly URL_RETRIEVAL_STATUS_SUCCESS: "URL_RETRIEVAL_STATUS_SUCCESS";
```

<a id="url_retrieval_status_unsafe"></a>

##### URL\_RETRIEVAL\_STATUS\_UNSAFE

```ts
readonly URL_RETRIEVAL_STATUS_UNSAFE: "URL_RETRIEVAL_STATUS_UNSAFE";
```

<a id="url_retrieval_status_unspecified"></a>

##### URL\_RETRIEVAL\_STATUS\_UNSPECIFIED

```ts
readonly URL_RETRIEVAL_STATUS_UNSPECIFIED: "URL_RETRIEVAL_STATUS_UNSPECIFIED";
```

## Functions

<a id="getai"></a>

### getAI()

#### Call Signature

```ts
function getAI(sandbox: Sandbox, options?: AIOptions): AI;
```

Construct a sandbox-backed [AI](#ai) handle:
  - `getAI()` uses the default app initialized through package resolution.
  - `getAI(sandbox, options?)` answers through the sandbox engine.
  - `getAI(app, options?)` preserves `ai.app === app`.

Repeat calls for the same owner and backend return a stable handle; the
first call's options win.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |
| `options?` | [`AIOptions`](#aioptions-1) |

##### Returns

[`AI`](#ai)

#### Call Signature

```ts
function getAI(app?: FirebaseApp, options?: AIOptions): AppAI;
```

Construct a sandbox-backed [AI](#ai) handle:
  - `getAI()` uses the default app initialized through package resolution.
  - `getAI(sandbox, options?)` answers through the sandbox engine.
  - `getAI(app, options?)` preserves `ai.app === app`.

Repeat calls for the same owner and backend return a stable handle; the
first call's options win.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app?` | `FirebaseApp` |
| `options?` | [`AIOptions`](#aioptions-1) |

##### Returns

`AppAI`

***

<a id="getgenerativemodel"></a>

### getGenerativeModel()

```ts
function getGenerativeModel(
   ai: AI,
   modelParams: ModelParams,
   requestOptions?: RequestOptions): GenerativeModel;
```

Return a sandbox-backed model with the canonical Firebase method shape.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ai` | [`AI`](#ai) |
| `modelParams` | [`ModelParams`](#modelparams) |
| `requestOptions?` | [`RequestOptions`](#requestoptions-2) |

#### Returns

[`GenerativeModel`](#generativemodel)
