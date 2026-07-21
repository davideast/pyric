# Storage Rules, `2+modules`, and a service-aware standard library

**Investigated:** 2026-07-20 at `6e5ecd6e3718`

**Primary sources:** Firebase Security Rules documentation and REST API reference; this repository's resolver, Storage evaluator, standard-library sources, and conformance inventory.

## Implementation status on this branch

The first trust slice recommended by this report is now implemented. Normal
Storage setup lowers `2+modules` through a service-aware resolver; `auth` and
`membership` are the only bundled modules admitted for both Firestore and
Storage; every other bundled module is explicitly Firestore-only; and caller
modules are checked transitively for Storage-incompatible bindings and
functions. A single targeted `projects.test` request captured 12 production
verdicts for the exact six admitted function bodies, and the local evaluator
matches all 12. The observation is registered as
`oracle:rules-storage-common-auth-membership` / `storage-rules#125`.

The first P2 Storage-native and mocked P3 cross-service matrices are now
captured as `rules-storage-upload-primitives-boundaries` and
`rules-storage-firestore-lookup-budget`. They used two batched Rules Test API
requests (40 cases total) and no real Storage or Firestore data. Direct
`parseStorageRules()` remains a plain-v2 parser; module lowering occurs in the
resolver and normal Storage service setup.

The captures established inclusive size limits, exact/whole-string MIME
behavior, metadata `keys().hasAll()` and `get(default)`, generation and
metageneration integer comparisons, strict time boundaries, and lazy
cross-service lookup evaluation. They also found three local divergences:
metadata collection methods are not implemented; missing `request.resource`
on delete is locally modeled as null instead of a production error; and an
anonymous `request.auth != null` ternary condition locally selects the alternate
branch while production errors before branch selection.

The mocked API ALLOWed three distinct lookup calls and reported all three in its
function-call diagnostics. Therefore mocks do **not** prove the documented
real-resource access budget. IAM, billing, database boundaries, rules
independence, and consistency still require the real-resource rig and remain
unclaimed.

### Follow-up discovery captures (2026-07-21)

The read-only `storage-stdlib-discovery` rig now records three additional
production boundaries. Paired Firestore/Storage requests reject braced imports
under both v2 and `2+modules`; the Rules Test API also rejects every two-file
source shape with `INVALID_ARGUMENT`, regardless of file order. The portable
deployment contract therefore remains Pyric-lowered, single-file v2 rather than
server-side linking.

Identical pure function bodies passed under both services for the tested string,
list, Map/MapDiff/Set, math, hashing, duration/timestamp, and LatLng families.
`math.isInfinite` denied under both services as an invalid function; the math
family passed after removing that control. These are candidate common-language
capabilities, not Pyric conformance credit, until each is implemented and
replayed locally.

The remaining synthetic Storage-native probe established metadata `diff()`
boundaries, timestamp-typed `resource.updated`, exact Unicode metadata equality,
and rule addressability of explicitly supplied md5/crc32c/etag fields. Synthetic
hash fields do not prove that real uploads populate them.

The first real-resource rig run restored the exact prior Storage release and
verified all run-scoped Firestore documents and Storage objects absent before
writing its capture. With cross-service IAM disabled, every executed
`firestore.get`/`exists` rule denied while a `true || lookup` rule allowed. The
original oracle service account and active human gcloud credential both lacked
`setIamPolicy`, so neither could run the enabled phase on `genkit-idx`; their
grant attempts failed before changing its policy. The separate `digame-mas`
credential had the complete bounded permission set and was used for the
temporary-IAM capture below. The rig also supports `--iam-enabled` when a
project administrator has enabled the role beforehand, without reading or
mutating IAM.

The IAM-enabled run on `digame-mas` established the core access contract: one
and two distinct existing-document lookups allowed, while three denied.
Repeating one path three times allowed, and combining `get` plus `exists` over
two distinct paths allowed, consistent with access-call caching. A negated
`exists` check for a missing document allowed; dereferencing a missing `get`
denied. The always-true short-circuit control allowed. IAM propagation required
a two-minute quiet interval; dense early retries incorrectly resembled a
disabled permission boundary. IAM removal also showed eventually consistent
reads, so the rig now performs delayed restoration verification and one bounded
repeat restoration before accepting cleanup.

The next IAM-enabled advanced matrix established:

- `get` returns nested maps and lists with the expected Rules types; nested field
  access and list membership allowed.
- Direct access to an absent field and comparing an integer field with a string
  denied instead of producing a false allow.
- An anonymous `request.auth.uid` path interpolation and a named-database path
  denied. The default-database path remained the only production-proven form.
- Lookup calls composed through a helper, a `let`-bound `get`, `false || call`,
  and the selected branch of a ternary expression all allowed.
- A missing-document dereference on the left of `|| true` allowed, confirming
  Storage shares the language's error-absorption behavior; `false &&` the same
  dereference denied without granting access.
- An anonymous Firestore client was demonstrably denied and then allowed for
  the run-scoped document as the temporary Firestore rules changed. The same
  Storage lookup allowed in both states. This pins cross-service lookup as IAM
  service-agent data access, not a request authorized through `firestore.rules`.

The advanced rig restores both exact Rules release pointers, and an exclusive
local lock now rejects overlapping real-resource runs before network mutation.

## Baseline conclusion

`storage.rules` does **not yet work end to end with `rules_version = '2+modules'` in Pyric's normal Storage path**.

There are two distinct behaviors today:

1. The generic module compiler can structurally resolve a Storage source. It parses the service name, loads imports from one flat standard-library catalog, injects the requested functions, and rewrites `2+modules` to `2`. It does not check whether an imported function is compatible with `firebase.storage` ([resolver core](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/rules/modules/resolver-core.ts#L242-L354), [browser catalog](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/rules/modules/resolver-browser.ts#L41-L69)).
2. The Storage service does not call that compiler. It passes the source directly to `parseStorageRules()`, which turns imports into unresolved stubs; calling one denies with an explicit “module resolution is not implemented” reason ([Storage service](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/storage/service.ts#L171-L204), [Storage parser](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/storage/rules.ts#L436-L480), [call behavior](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/storage/rules.ts#L1043-L1060)).

That mismatch is a Trust issue, not merely missing convenience. If Pyric simply wires the current resolver into Storage, `auth.isAuthenticated()` can plausibly work, but Firestore-bound helpers such as `lifecycle.immutableFields()` will also compile and then depend on `request.resource.data`, `resource.data`, and `MapDiff` semantics that Storage does not provide in that shape. A successful compile would overstate compatibility.

The recommendation is a **service-aware, capability-checked module compiler**:

```text
parsed target service
        |
        v
common capability intersection + target-service capabilities
        |
        v
resolve imports and transitive private dependencies
        |
        v
reject incompatible exports before emitting plain v2
        |
        v
target evaluator + production-backed conformance evidence
```

Ship no new Storage module merely because its source looks plausible. First run the proposed probes below, promote only production-observed behavior into the capability catalog, and keep unverified capability combinations fail-closed.

## What Firebase itself guarantees

### One language family, separate service scopes

Firestore and Storage share the Rules language's service/match/allow/function structure and the granular `get`, `list`, `create`, `update`, and `delete` methods plus `read`/`write` umbrellas ([Rules language](https://firebase.google.com/docs/rules/rules-language)). They do **not** share one deployable rules source: Firebase permits one `service` declaration per source file and requires separate files for Firestore and Storage ([Rules language, Service](https://firebase.google.com/docs/rules/rules-language#service)). Storage's `service firebase.storage` scope exists specifically to prevent conflicts with rules for products such as Firestore ([Storage core syntax](https://firebase.google.com/docs/storage/security/core-syntax#service_and_database_declaration)).

Firebase publicly documents the latest production syntax as v2, while Pyric's resolver uses `rules_version = '2+modules'` plus braced `import`/`export` as an authoring format and lowers it to ordinary v2 before evaluation or deployment ([Firebase syntax version](https://firebase.google.com/docs/rules/rules-language#syntax_version), [Pyric resolver](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/rules/modules/resolver-core.ts#L242-L354)). The repository says the grammar also models a server-gated modules preview: a live Rules Test API observation on the test project rejected braced imports even under `2+modules`, while the parser deliberately retained them for preview modeling ([commit `d24ee1e5`](https://github.com/davideast/pyric/commit/d24ee1e5ae0de444963683bc053222c59c4aef14)). Thus it is too broad to call every import construct purely invented, but it is equally unsafe to call it stock Firebase syntax. Preview parsing, Pyric's local linker, and portable deployed v2 are separate contracts.

The Rules management API adds another layer: a `Source` is a bundle of one or more named `File` messages ([Ruleset Source](https://firebase.google.com/docs/reference/rules/rest/v1/projects.rulesets#Source)). Multiple files in the transport do not, by themselves, prove that braced imports link between those files, that the Firebase CLI uploads the same bundle, or that either behavior is enabled for Storage. Those are probe questions, not conclusions available from the schema.

Therefore module portability is a contract Pyric must define and prove; it cannot be inferred from shared syntax, parser acceptance, or a multi-file REST payload.

### Existing trust contradiction

The current Storage syntax-acceptance test says every case is accepted by production, but includes `rules_version = '2'; import { isOwner } from 'shared';` ([test](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/test/storage/rules-syntax-features.test.ts#L1-L108)). That conflicts with both the documented v2 surface and the repository's later live observation that braced imports were rejected on an ordinary project even under `2+modules` ([commit](https://github.com/davideast/pyric/commit/d24ee1e5ae0de444963683bc053222c59c4aef14)). The test currently proves only **Pyric parser acceptance**. Its production claim should be removed or qualified until project-entitlement probes establish otherwise, and the Storage rules-language inventory needs an explicit import/preview construct analogous to Firestore's existing discrepancy row.

### The documented shared language surface

The two service references overlap on core values and operations: null, Boolean, integer/float arithmetic, strings, paths, lists, maps, timestamps, durations, type checks, functions, and short-circuit error semantics. Storage additionally documents `math` helpers, string `matches`/`split`, list membership/`join`/`hasAll`, map `keys`/`values`, and timestamp accessors ([Storage reference](https://firebase.google.com/docs/reference/security/storage)). Firestore's reference is richer and separately lists Bytes, LatLng, MapDiff, Set, hashing, and additional methods and namespaces ([Firestore Rules API overview](https://firebase.google.com/docs/reference/rules)).

Do **not** treat the union of those references as a universal surface. In particular, Firestore's MapDiff/Set and hashing/Bytes/LatLng APIs are only candidates for paired probes unless the Storage reference or production observations establish them. Even the documented overlap is not proof that Pyric's two evaluators implement every item. The current Storage evaluator implements only a subset: `matches`, `split`, `size`, `timestamp.date/value`, `duration.value`, and injected `firestore.get/exists`, while unknown methods deny ([Storage built-ins](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/storage/rules.ts#L1200-L1263)). Pyric's Storage rules-language inventory already labels it a “standalone subset” and records the injected-lookup qualification ([inventory](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/conformance/rules-language/storage.json#L1-L190)).

### Ambient bindings are service-specific

Both services expose names such as `request`, `resource`, and `request.auth`, but the values behind those names differ materially:

| Surface | Firestore | Storage |
|---|---|---|
| existing resource | document resource with `.data` | object metadata (`name`, `bucket`, `size`, times, hashes, content fields, custom `metadata`) |
| incoming resource | document with `.data` | proposed object metadata with the documented subset of object fields |
| path root | `/databases/{database}/documents` | `/b/{bucket}/o` |
| document access | bare `get`, `exists`, `getAfter` | qualified `firestore.get`, `firestore.exists` |
| query/batch semantics | Firestore query proof and atomic post-write access | object get/list/upload/metadata/delete semantics |

The Storage object-field contract is documented in the Storage reference ([request](https://firebase.google.com/docs/reference/security/storage#request), [resource](https://firebase.google.com/docs/reference/security/storage#resource)); Firestore's unqualified document functions are available only inside `service cloud.firestore` ([Firestore namespace](https://firebase.google.com/docs/reference/rules/rules.firestore)). A helper that closes over `request.resource.data` is therefore Firestore-specific even if its arithmetic and map operations are universal.

## Current standard-library cross-reference

The existing manifest intentionally calls itself the **Firestore Rules Standard Library** and divides its advanced functions by patterns and evidence ([manifest](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/rules/modules/stdlib/STDLIB.md)). Its useful design lesson is not the current flat catalog; it is the progression from small reusable primitives to advanced functions discovered and production-verified through probes, especially `timing`, `geometry`, `spaces`, `joining`, and `atomic`.

### Existing exports by portability

| Existing module/functions | Classification for Storage | Reason |
|---|---|---|
| `auth`: `isAuthenticated`, `isOwner(userId)` | common candidate, executable now | Uses only `request.auth`; Storage documents the same UID/token shape. |
| `membership`: `hasClaim`, `hasClaimRole`, `isMemberOf(map)`, `hasRole(map, role)` | common candidate, executable now; production probe required | Uses auth plus explicit map parameters, not `.data`. This is the strongest existing reusable module. |
| `atomic`: `companionChangedBy`, `consumedFlag` | source-pure common candidate, executable now; production probe required | Inputs are explicit maps and the bodies use only indexing, equality, and arithmetic. The module name and Firestore batch examples are misleading for Storage, so portable value-transition helpers may deserve a neutral home rather than promoting `atomic` unchanged. |
| `validation`, `lifecycle`, `content`, `counters`, `transitions`, `timing` | Firestore-specific as written | Close over `request.resource.data` and/or `resource.data`. Storage analogues need object/metadata semantics, not blind reuse. |
| `spaces` | mixed | Read-side membership helpers accept explicit data and can be generalized; `validMemberCreate` closes over Firestore `.data`. |
| `geometry`, `joining`, `lobby`, `turns`, `state` | Firestore-specific/domain-specific | Depend on Firestore document shapes, MapDiff support, or game conventions. |

The safe rule is: **a shared name is not a shared type**. Only helpers whose full transitive body uses capabilities in the proven service intersection are universal.

## Cross-service behavior: what it is and is not

Storage Rules may read Cloud Firestore documents through `firestore.get()` and `firestore.exists()` with fully specified paths. Firebase caps a Storage evaluation at two Firestore document accesses, may cache repeated accesses, charges the reads, and limits access to the default Firestore database in multi-database projects ([Storage conditions](https://firebase.google.com/docs/storage/security/rules-conditions#enhance_with_cloud_firestore), [Rules limits](https://firebase.google.com/docs/rules/rules-behavior#security_rule_limits)). Enabling this feature grants the Firebase Storage service account the `Firebase Rules Firestore Service Agent` IAM role; removing it makes such Storage evaluations fail ([cross-service permissions](https://firebase.google.com/docs/rules/manage-deploy#manage_permissions_for_cross-service_cloud_storage_security_rules)).

This is cross-service **data access**, not cross-service rules composition. Firebase still deploys the two rulesets separately. The IAM-backed design implies that a Storage lookup is not a simulated client request authorized by the matched clauses in `firestore.rules`; the Storage condition itself decides how the returned document affects object access. That last sentence is an inference from the documented separate releases plus service-agent IAM mechanism, and should be pinned with a real-database probe before Pyric publishes it as a guarantee.

Pyric already models the sanctioned direction: its Storage evaluator accepts an injected `FirestoreLookup`; sandbox enforcement supplies the project Firestore view, while pure evaluation without the capability denies ([interface and contract](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/storage/rules.ts#L197-L221), [evaluation](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/pyric/src/storage/rules.ts#L1266-L1320)). That does not justify importing Firestore helpers. A Firestore helper that calls bare `get()` or reads `resource.data` remains incompatible inside Storage; a Storage-specific helper may call qualified `firestore.get()`, or preferably accept the looked-up `.data` as an explicit parameter so lookup count and path stay visible at the call site.

## Proposed module model

### 1. Resolve against a target capability contract

Derive the target from `ast.service.name` and validate every requested export plus all transitive private helpers before injection.

```ts
type RulesService = 'firestore' | 'storage';

interface FunctionContract {
  services: readonly RulesService[];
  requires: readonly CapabilityId[];
  evidence: readonly ConformanceNodeId[];
}

interface ModuleContract {
  key: string;
  exports: Readonly<Record<string, FunctionContract>>;
}
```

Capabilities should be semantic, not string heuristics: `binding.request.auth`, `binding.firestore.resource.data`, `binding.storage.request.resource.size`, `method.map.diff`, `namespace.storage.firestore.get`, and so on. Shipped modules carry reviewed contracts. Relative and caller-supplied modules must be statically analyzed over their complete transitive call graph; unknown/dynamic requirements fail closed until classified.

On mismatch, return `INCOMPATIBLE_FUNCTION` (or `INCOMPATIBLE_MODULE` when every requested export is incompatible) naming the target service and first missing capability. Do this before emitting plain v2. Keep the current duplicate/private/export checks.

### 2. Preserve a small import taxonomy

Avoid making users learn a matrix of package names:

- `auth` and `membership` remain common, backward-compatible keys once Storage probes pass.
- Firestore-only existing keys remain as-is for compatibility but their contracts reject Storage targets.
- New service-specific modules use an explicit `storage/` prefix (`storage/uploads`, `storage/metadata`, `storage/objects`, `storage/firestore-access`).
- Documentation may group modules as **common** and **advanced**, but compatibility is enforced per export because one mixed module can contain both portable and service-bound functions.

### 3. Keep lookup wiring explicit

Advanced cross-service helpers should prefer this shape:

```rules
function membershipDoc(uid) {
  return firestore.get(
    /databases/(default)/documents/memberships/$(uid)
  ).data;
}

allow read: if hasRole(membershipDoc(request.auth.uid), 'editor');
```

`hasRole(data, role)` is common policy; `firestore.get(...)` remains visibly Storage-specific, billable, limited, and path-bound. A convenience helper that hides the lookup should live under `storage/firestore-access`, declare the lookup capability and budget cost, and only ship after limit/caching probes.

## Candidate Storage modules

These are proposals to probe, not implementation commitments.

### Common modules to promote first

| Module | Candidate exports | Why first |
|---|---|---|
| `auth` | existing `isAuthenticated`, `isOwner(userId)` | Same documented auth binding; no object-model dependency. |
| `membership` | existing claim and explicit-map helpers | Reuses explicit parameters and avoids ambient `.data`. |
| `values` (possible extraction) | `validString(value,min,max)`, `isOneOf(value,values)`, `boundedNumber(value,min,max)` | Value-oriented variants are genuinely portable and avoid separate Firestore/Storage field conventions. Only add if this reduces rather than duplicates the public concept set. |

### Storage common layer

| Module | Candidate exports | Required evidence |
|---|---|---|
| `storage/uploads` | `sizeAtMost(bytes)`, `sizeBetween(min,max)`, `contentTypeMatches(re)`, `contentTypeIsOneOf(types)` | create/update/delete availability of `request.resource`; missing `contentType`; RE2 and list membership. |
| `storage/metadata` | `hasRequiredMetadata(keys)`, `hasOnlyMetadata(keys)`, `metadataString(key,min,max)`, `incomingMetadataOwner(key)`, `existingMetadataOwner(key)` | exact map methods on `Map<String,String>`, absent-key error behavior, empty metadata, create vs update. |
| `storage/objects` | `isCreate()`, `isUpdate()`, `isDelete()`, `contentUnchanged()`, `metadataOnlyUpdate()` | `resource == null`, `request.resource` on each verb, which server fields are comparable, generation/metageneration behavior. |
| `storage/time` | `createdWithin(seconds)`, `updatedWithin(seconds)` | timestamp arithmetic, strict boundary, future timestamps, missing resource, method applicability. |

### Storage advanced layer

| Module | Candidate exports | Why advanced |
|---|---|---|
| `storage/image-uploads` | `validImageUpload(maxBytes, allowedTypes)`, optional extension/content-type agreement | Composes path, size, and MIME claims; spoofed MIME/extension behavior must be explained rather than implied to inspect bytes. |
| `storage/metadata-lifecycle` | `immutableMetadata(keys)`, `onlyMetadataChanged(keys)`, `ownerMetadataUnchanged(key)` | Depends on whether `Map.diff` works on Storage custom metadata and how absent/server fields behave. |
| `storage/firestore-access` | membership/role policy over explicit lookup results; perhaps a narrowly named lookup wrapper | Cross-service IAM, two-read budget, caching, default-database restriction, and missing/type errors. |
| `storage/integrity` | hash/generation/metageneration guards | `md5Hash`, `crc32c`, `etag`, generation fields are server-shaped and collision caveats matter; production request visibility must be established. |
| `storage/path-policy` | filename/extension/segment constraints | Storage has flat object names despite slash-like prefixes; wildcard type and `request.path` behavior need probes. |

Do not call MIME or hash helpers “content validation” unless the rule actually observes trusted content bytes. Firebase's own examples validate metadata such as `contentType` and size ([Storage data validation](https://firebase.google.com/docs/storage/security/rules-conditions#validate_data)); module names and docs should preserve that distinction.

## Probe program

The existing Storage oracle runner is the right base: it sends an inline Storage source and cases to the production `projects.test` endpoint, records verdicts, then replays them against Pyric ([runner](https://github.com/davideast/pyric/blob/6e5ecd6e3718/packages/conformance/src/run-rules-storage.ts#L1-L20)). The official endpoint validates syntax and semantics before cases run, supports service-dependent request/resource values and service-function mocks, and can return visited expressions and function calls ([Rules `projects.test`](https://firebase.google.com/docs/reference/rules/rest/v1/projects/test)).

Each candidate should have three gates:

1. **compiler isolation:** resolver accepts the right service and rejects the wrong one, including transitive private dependencies and caller-supplied modules;
2. **oracle semantics:** production `projects.test` verdict matrix with boundary and error cases;
3. **mirror replay:** exact verdicts locally, with any unavailable real-resource behavior moved to a credentialed emulator/production probe rather than guessed.

### P0 — trust boundary and module wiring

| Probe | Matrix | Expected learning |
|---|---|---|
| Import syntax/version acceptance | Firestore + Storage; v2 + `2+modules`; ordinary project + preview-entitled project if available | Separates public v2, server-gated preview syntax, and service entitlement. Record exact compile issue rather than only ALLOW/DENY. |
| Multi-file Rules API source | one file vs entry file + named helper file; with/without import; file-order permutations | Establishes whether `Source.files[]` is merely a bundle or a linker input, and how symbols resolve. |
| Firebase CLI deployment | equivalent `firebase.json` Firestore and Storage targets; inspect API request or retrieved ruleset | Establishes whether the CLI sends one file, a bundle, or preprocesses imports, separately from direct REST behavior. |
| Pyric compile then production test | module source, emitted plain-v2 source, both sent to `projects.test` | Confirms Pyric's portable contract is the emitted v2 artifact even when preview syntax is unavailable upstream. |
| Storage imports `auth.isAuthenticated` | anon/authenticated; direct parse vs resolve-then-parse | Pins the current split and the intended end-to-end path. |
| Storage imports Firestore `lifecycle.immutableFields` | compile only | Must fail `INCOMPATIBLE_FUNCTION`, not emit source that later denies. |
| Firestore imports `storage/uploads.sizeAtMost` | compile only | Proves isolation is symmetric. |
| Mixed module exports one common and one service-specific function | import each alone, then both | Proves compatibility is export-level. |
| Private helper introduces incompatible binding | exported wrapper looks common but calls private `.data` helper | Proves transitive checks cannot be bypassed. |
| Relative/user module uses unknown method | Storage and Firestore targets | Unknown capability fails closed rather than trusting unreviewed code. |
| Same source through Node and browser resolver | built-in key, path alias, caller override | Pins catalog parity and prevents browser-only trust drift. |

### P1 — universal intersection

Run identical ordinary-v2 function bodies under both service declarations where the request fixture permits it:

- auth null/UID/token claim access, including missing claims;
- explicit map membership and bracket access, including absent keys and prototype-like strings;
- `Map.keys/get/diff`, List/Set conversion and membership;
- string `size/matches/split/replace/trim/lower/upper/toUtf8` with empty, Unicode, and invalid RE2 cases;
- `duration`, `timestamp`, `math`, `hashing`, and `latlng` namespaces with type errors and numeric boundaries;
- function lexical scope, let limits, recursion/call-depth failure, and short-circuit error absorption.

The result should be a capability intersection backed by paired observations, not a hand-maintained “universal functions” list copied from the reference.

### P2 — Storage upload and metadata primitives

| Probe family | Cases that matter |
|---|---|
| request/resource presence | create absent existing resource; update existing; delete missing `request.resource`; get/list behavior; negation of missing-field errors. |
| size | 0, 1, exact maximum, maximum+1, large int arithmetic, updateMetadata where bytes do not change. |
| MIME | absent, exact type, parameterized type, case differences, whole-string regex anchoring, extension agrees/disagrees. |
| metadata shape | empty map, required/extra keys, missing key direct access vs `in` vs `get(default)`, Unicode strings, max practical key/value sizes. |
| metadata diff | added/removed/changed/unchanged keys; no-op update; compare only custom metadata versus whole request/resource maps. |
| object identity | full `resource.name`, bucket, path wildcard type, generation/metageneration increments, create/update/delete visibility. |
| time | exact cooldown boundary, just before/after, `timeCreated` vs `updated`, future values, missing resource, timestamp accessors. |
| hashes | visibility of md5/crc32c/etag on existing and incoming objects; overwrite equality; malformed/client-supplied values; document collision caveat. |

This is the Storage analogue of how Firestore timing emerged: probe the native server-owned values and error edges first, then wrap only the stable relationship.

### P3 — advanced cross-service lookups

Use function mocks for fast Rules Test API shape discovery, then a real Firestore database + Storage request rig for IAM and consistency claims.

1. **Path contract:** fully qualified default path; named database; malformed prefix; odd collection/document segments; wildcard and auth interpolation; null/non-string interpolation.
2. **Return/error contract:** existing document, missing `get`, missing `exists`, field absent, wrong field type, nested maps/lists, document reference/timestamp values.
3. **Budget:** zero, one, two, and three distinct documents; repeat the same lookup; `get` then `exists` on the same path; short-circuited third lookup. Record function calls as well as allow/deny.
4. **Caching:** repeated identical paths versus textually different paths resolving to the same document. Determine what actually counts toward two accesses.
5. **Evaluation order:** `true || lookup`, `false && lookup`, `false || lookup`, ternary branches, helper-called lookup, lookup in `let` binding.
6. **Database boundary:** `(default)` allowed; named database denied when multiple databases exist.
7. **IAM:** role enabled/removed/restored; verify failures deny and surface no false allow.
8. **Rules independence:** deploy Firestore deny-all versus allow-all while the IAM role and document stay fixed; execute the same Storage request. This pins the inference that Storage lookup is not authorized by the Firestore ruleset.
9. **Consistency:** mutate a membership document immediately before a Storage request and observe old/new value; repeat to characterize, not promise, visibility.
10. **Pyric project isolation:** two sandbox project IDs with identical paths and different documents; Storage must read only its owning project's Firestore view.

High-value module candidates emerge from these outcomes. For example, if repeated identical lookup calls are cached and explicit-map policy composes cleanly, keep only common `hasRole(data, role)` and teach a visible one-lookup caller pattern. If lookup wrappers obscure budget or caching, do not ship them.

## Recommended delivery order

1. Add compiler-level tests that pin today's direct-parse denial and generic-resolver acceptance as separate facts.
2. Correct the Storage syntax test's blanket production claim and probe version/import acceptance, multi-file REST linking, preview entitlement, and CLI preprocessing as distinct facts.
3. Introduce the service/capability contracts and fail-closed resolver errors, covering transitive and caller-supplied modules.
4. Run P1 paired probes; promote only `auth`/`membership` exports that pass into the common intersection.
5. Wire Storage service setup through the checked resolver. The resolved plain-v2 source, target service, modules, and evidence IDs should be inspectable for assurance.
6. Run P2; add the smallest Storage common modules whose functions are production-proven and broadly reusable.
7. Run P3 before adding advanced cross-service helpers. Record lookup-budget and IAM limitations in both module documentation and conformance nodes.
8. Keep every unsupported or unverified function queryable as such. A compiler rejection with a precise missing capability is more trustworthy than a module that resolves and silently denies at runtime.

## Answer to the trust question

Today, `2+modules` is trustworthy for the Firestore path it was built around, but not as a multi-service claim. Storage syntax acceptance, generic compilation, direct Storage parsing, local evaluation, and production behavior are five different facts and currently do not line up.

The smallest honest contract is:

- modules compile for an explicit service target;
- every imported function and private dependency declares or derives its required capabilities;
- `common` means proven in both Firestore and Storage, not merely syntactically generic;
- service-specific ambient bindings never cross the boundary;
- Storage-to-Firestore access is modeled as a qualified, limited runtime capability, not permission to reuse Firestore-bound helpers;
- production probes are attached to the exact export/capability claims that assurance relies on.

That makes multi-module Storage support a visible, testable extension of the conformance graph instead of a flat catalog silently shared by two different evaluators.
