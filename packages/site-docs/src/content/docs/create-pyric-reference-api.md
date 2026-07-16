---
title: "API reference: create-pyric"
navLabel: "create-pyric"
group: "API reference"
section: "create-pyric"
order: 9002
description: "Published declarations for create-pyric."
kind: "api"
apiPackage: "create-pyric"
apiImportPath: "create-pyric"
apiSubpath: ""
apiSymbolCount: 15
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="createargs"></a>

### CreateArgs

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="flags"></a> `flags` | `Map`\<`string`, [`FlagValue`](#flagvalue)\> |
| <a id="positional"></a> `positional` | `string`[] |

***

<a id="packagejsonmerge"></a>

### PackageJsonMerge

`create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="added"></a> `added` | `string`[] |
| <a id="conflicts"></a> `conflicts` | \{ `existing`: `unknown`; `key`: `string`; `wanted`: `unknown`; \}[] |
| <a id="contents"></a> `contents` | `string` |
| <a id="unchanged"></a> `unchanged` | `boolean` |

***

<a id="scaffoldio"></a>

### ScaffoldIo

`create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cwd"></a> `cwd?` | `string` |
| <a id="exists"></a> `exists?` | (`path`: `string`) => `Promise`\<`boolean`\> |
| <a id="mkdir"></a> `mkdir?` | \{ (`path`: `PathLike`, `options`: `MakeDirectoryOptions` & \{ \}): `Promise`\<`string`\>; (`path`: `PathLike`, `options?`: \| `Mode` \| `MakeDirectoryOptions` & \{ \}): `Promise`\<`void`\>; (`path`: `PathLike`, `options?`: `Mode` \| `MakeDirectoryOptions`): `Promise`\<`string`\>; \} |
| <a id="readfile"></a> `readFile?` | \{ (`path`: `PathLike` \| `FileHandle`, `options?`: \{ \} & `Abortable`): `Promise`\<`NonSharedBuffer`\>; (`path`: `PathLike` \| `FileHandle`, `options`: \| `BufferEncoding` \| \{ \} & `Abortable`): `Promise`\<`string`\>; (`path`: `PathLike` \| `FileHandle`, `options?`: \| `BufferEncoding` \| `ObjectEncodingOptions` & `Abortable` & \{ \}): `Promise`\<`string` \| `NonSharedBuffer`\>; \} |
| <a id="stderr"></a> `stderr?` | \{ `write`: `void`; \} |
| `stderr.write` | `void` |
| <a id="stdout"></a> `stdout?` | \{ `write`: `void`; \} |
| `stdout.write` | `void` |
| <a id="writefile"></a> `writeFile?` | (`file`: `PathLike` \| `FileHandle`, `data`: \| `string` \| `ArrayBufferView`\<`ArrayBufferLike`\> \| `Iterable`\<string \| ArrayBufferView\<ArrayBufferLike\>, `any`, `any`\> \| `AsyncIterable`\<string \| ArrayBufferView\<ArrayBufferLike\>, `any`, `any`\>, `options?`: \| `ObjectEncodingOptions` & \{ \} & `Abortable` \| `BufferEncoding`) => `Promise`\<`void`\> |

***

<a id="scaffoldrequest"></a>

### ScaffoldRequest

`create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="commandlabel"></a> `commandLabel?` | `string` | Label used in human report lines (`create-pyric` or `pyric init`). |
| <a id="depsmode"></a> `depsMode?` | [`DepsMode`](#depsmode-2) | - |
| <a id="dir"></a> `dir?` | `string` | Absolute or relative project directory (relative resolved against cwd). |
| <a id="effectivetemplate"></a> `effectiveTemplate?` | [`ScaffoldTemplate`](#scaffoldtemplate) | Already-rewritten template; defaults to TEMPLATES[template] (+ npm pin). |
| <a id="force"></a> `force?` | `boolean` | - |
| <a id="json"></a> `json?` | `boolean` | - |
| <a id="name"></a> `name?` | `string` | - |
| <a id="pinversion"></a> `pinVersion?` | `string` | Version pin for npm-mode `@pyric/cli` / `pyric` ranges. |
| <a id="precreated"></a> `preCreated?` | `string`[] | Extra paths already created (e.g. vendor tarballs) to list in the report. |
| <a id="template"></a> `template?` | `"web"` \| `"node"` \| `"static"` | - |

***

<a id="scaffoldresult"></a>

### ScaffoldResult

Stable `--json` contract; agents parse this.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="conflicts-1"></a> `conflicts` | \{ `existing`: `unknown`; `key`: `string`; `wanted`: `unknown`; \}[] |
| <a id="created"></a> `created` | `string`[] |
| <a id="depsmode-1"></a> `depsMode` | [`DepsMode`](#depsmode-2) |
| <a id="dir-1"></a> `dir` | `string` |
| <a id="merged"></a> `merged` | `string`[] |
| <a id="nextsteps"></a> `nextSteps` | `string`[] |
| <a id="skipped"></a> `skipped` | `string`[] |
| <a id="template-1"></a> `template` | `"web"` \| `"node"` \| `"static"` |

***

<a id="scaffoldtemplate"></a>

### ScaffoldTemplate

Scaffold templates for `pyric init` (engine in `./init.js`).

`web` (the default) scaffolds a **Vite app** wired to the `@pyric/cli/vite`
plugin: `vite dev` runs the app's CANONICAL `firebase/*` imports against the
in-process sandbox; `vite build` ships the real `firebase` package. One
toolchain, no graduation cliff — the sandbox↔Firebase swap is environmental
(dev vs build), never a code edit (the design rationale section 9).

`static` is the serve-era scaffold (no bundler): a static app `pyric dev`
runs against the in-page sandbox via a runtime import map. For pre-built /
retrofit apps, or anyone who wants zero build step.

`node` is the script-style scaffold (backend fixtures, agent loops). Its
canonical imports are swapped by the dev command and remain Firebase under
the production command.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="dependencies"></a> `dependencies` | `Record`\<`string`, `string`\> | - |
| <a id="devdependencies"></a> `devDependencies` | `Record`\<`string`, `string`\> | - |
| <a id="dirs"></a> `dirs` | `string`[] | Directories created before writing files (relative to the project dir). |
| <a id="nextsteps-1"></a> `nextSteps` | `string`[] | Literal commands for the report / `--json` consumers. |
| <a id="overrides"></a> `overrides?` | `Record`\<`string`, `string`\> | npm/bun `overrides` (optional). Vendor mode sets `{ pyric: file:… }` so a transitive `pyric` dep can't resolve to the published placeholder. |
| <a id="scripts"></a> `scripts` | `Record`\<`string`, `string`\> | package.json pieces merged into existing files / written into new ones. |

#### Methods

<a id="files"></a>

##### files()

```ts
files(name: string): {
  content: string;
  name: string;
}[];
```

Scaffold-owned files, relative path → content.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |

###### Returns

\{
  `content`: `string`;
  `name`: `string`;
\}[]

## Type Aliases

<a id="depsmode-2"></a>

### DepsMode

```ts
type DepsMode = "vendor" | "npm";
```

Where the scaffold's `pyric` / `@pyric/cli` deps come from.

***

<a id="flagvalue"></a>

### FlagValue

```ts
type FlagValue = string | boolean | (string | boolean)[];
```

Minimal argv parser for `create-pyric` (no subcommand — first bare
arg is the target directory).

## Variables

<a id="templates"></a>

### TEMPLATES

```ts
const TEMPLATES: Record<"web" | "node" | "static", ScaffoldTemplate>;
```

`create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.

## Functions

<a id="applydepsmode"></a>

### applyDepsMode()

```ts
function applyDepsMode(
   t: ScaffoldTemplate,
   mode: DepsMode,
   opts: {
  vendorSpecs?: Record<string, string>;
  version?: string;
}): ScaffoldTemplate;
```

Return a copy of `t` with `pyric` / `@pyric/cli` deps rewritten for `mode`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `t` | [`ScaffoldTemplate`](#scaffoldtemplate) |
| `mode` | [`DepsMode`](#depsmode-2) |
| `opts` | \{ `vendorSpecs?`: `Record`\<`string`, `string`\>; `version?`: `string`; \} |
| `opts.vendorSpecs?` | `Record`\<`string`, `string`\> |
| `opts.version?` | `string` |

#### Returns

[`ScaffoldTemplate`](#scaffoldtemplate)

***

<a id="mergeintoexistingpackagejson"></a>

### mergeIntoExistingPackageJson()

```ts
function mergeIntoExistingPackageJson(
   raw: string,
   projectName: string,
   template: ScaffoldTemplate): PackageJsonMerge;
```

Merge template fields into an existing package.json. Never overwrites.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `raw` | `string` |
| `projectName` | `string` |
| `template` | [`ScaffoldTemplate`](#scaffoldtemplate) |

#### Returns

[`PackageJsonMerge`](#packagejsonmerge)

***

<a id="normalizeboolflags"></a>

### normalizeBoolFlags()

```ts
function normalizeBoolFlags(flags: Map<string, FlagValue>, positional: string[]): void;
```

Reclaim `--force dir` / `--json dir` when a parser bound the value as the flag.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `flags` | `Map`\<`string`, [`FlagValue`](#flagvalue)\> |
| `positional` | `string`[] |

#### Returns

`void`

***

<a id="packagejsonfor"></a>

### packageJsonFor()

```ts
function packageJsonFor(name: string, t: ScaffoldTemplate): string;
```

`create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |
| `t` | [`ScaffoldTemplate`](#scaffoldtemplate) |

#### Returns

`string`

***

<a id="parsecreateargs"></a>

### parseCreateArgs()

```ts
function parseCreateArgs(argv: string[]): CreateArgs;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `argv` | `string`[] |

#### Returns

[`CreateArgs`](#createargs)

***

<a id="runscaffold"></a>

### runScaffold()

```ts
function runScaffold(request: ScaffoldRequest, deps?: ScaffoldIo): Promise<number>;
```

Write the scaffold into `dir`. Caller prepares vendor tarballs / pin when
needed and may pass `effectiveTemplate`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | [`ScaffoldRequest`](#scaffoldrequest) |
| `deps?` | [`ScaffoldIo`](#scaffoldio) |

#### Returns

`Promise`\<`number`\>
