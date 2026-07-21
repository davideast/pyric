# Rules Standard Library — Module Manifest

Last audited: 2026-07-21

The catalog remains Firestore-first, with a small Storage-native layer. Service compatibility is enforced per
module/export by the `2+modules` resolver rather than inferred from shared Rules
syntax. Only `auth` and `membership` are admitted for both Firestore and
Storage; the `storage/*` modules are Storage-only; all remaining modules are
Firestore-only. Newly promoted cross-service and Storage-native modules are
listed only after their production observations replay locally and their
executable fixtures pass. Legacy Firestore modules retain the evidence level
shown in each row's **Verified** column.

## Module Index

| Module | Exports | Services | Dependency | Pattern | Verified |
|--------|---------|----------|------------|---------|----------|
| [auth](#auth) | 2 | Firestore + Storage | Self-contained | — | Simulator + Storage production |
| [validation](#validation) | 2 | Firestore | Self-contained | — | Simulator |
| [lobby](#lobby) | 3 | Firestore | Self-contained | — | Simulator |
| [turns](#turns) | 2 | Firestore | Self-contained | — | Simulator |
| [state](#state) | 3 | Firestore | Self-contained | — | Simulator |
| [membership](#membership) | 4 | Firestore + Storage | Self-contained | — | Simulator + Storage production |
| [storage/uploads](#storageuploads) | 4 | Storage | Self-contained | — | Storage evaluator + production oracle |
| [storage/metadata](#storagemetadata) | 4 | Storage | Self-contained | — | Storage evaluator + production oracle |
| [storage/objects](#storageobjects) | 3 | Storage | Self-contained | — | Storage evaluator + production oracle |
| [storage/time](#storagetime) | 2 | Storage | Self-contained | — | Storage evaluator + production oracle |
| [lifecycle](#lifecycle) | 2 | Firestore | Self-contained | — | Simulator |
| [transitions](#transitions) | 3 | Firestore | Self-contained | — | Simulator |
| [geometry](#geometry) | 2 | Firestore | Explicit param | Patterns 12-14 | Simulator + live Rules validation |
| [counters](#counters) | 3 | Firestore | Self-contained | — | Simulator |
| [timing](#timing) | 1 | Firestore | Self-contained | — | Simulator + live Rules validation |
| [content](#content) | 4 | Firestore | Self-contained | — | Simulator |
| [spaces](#spaces) | 3 | Firestore | Explicit param | — | Simulator + live Rules validation |
| [joining](#joining) | 2 | Firestore | Self-contained | — | Simulator + live Rules validation |
| [atomic](#atomic) | 2 | Firestore | Explicit param | — | Simulator bodies + live real-DB validation |

## Dependency Types

- **Self-contained**: Only references `request`, `resource`, `request.auth`. No user-defined functions needed.
- **Explicit param**: Requires caller to pass data (e.g., config doc result) as a function parameter. No implicit dependencies.

## Modules

### auth

Access control primitives.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isAuthenticated()` | — | bool | `request.auth != null` |
| `isOwner(userId)` | userId: string field path | bool | `request.auth.uid == userId` — when `isOwner(resource.data.<field>)` guards a `list` rule, queries must carry `where('<field>', '==', request.auth.uid)` (rules are not filters) |

File: `auth.rules` | Tests: `auth.test.json`

### validation

Document field validation.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `hasRequired(fields)` | fields: list of field names | bool | `request.resource.data.keys().hasAll(fields)` |
| `hasOnly(fields)` | fields: list of field names | bool | `request.resource.data.keys().hasOnly(fields)` |
| `validString(field, min, max)` | field: string, min/max: int | bool | Incoming field is a string with size in [min, max]; missing field fails (null-on-miss, not error) |
| `isOneOf(field, values)` | field: string, values: list | bool | Incoming field value is in the allowed list (enum check) |

File: `validation.rules` | Tests: `validation.test.json`

### lobby

Game session lifecycle (create, join, cancel).

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `validCreate()` | — | bool | Host is auth user, guest empty, status waiting |
| `validJoin()` | — | bool | Guest slot empty, joiner is not host, status → playing |
| `canCancel()` | — | bool | Status is waiting, requester is host |

Convention: uses `host`/`guest`/`status` fields on document.

File: `lobby.rules` | Tests: `lobby.test.json`

### turns

Turn enforcement for two-player games.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isMyTurn()` | — | bool | Current player matches auth uid (host/guest) |
| `turnFlipped()` | — | bool | currentTurn alternates between host and guest |

Convention: uses `host`/`guest`/`currentTurn` fields on document.

File: `turns.rules` | Tests: `turns.test.json`

### state

Game state tracking.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isPlaying()` | — | bool | `resource.data.status == 'playing'` |
| `moveIncremented()` | — | bool | moveCount increased by exactly 1 |
| `participantsUnchanged()` | — | bool | host and guest fields unchanged |

File: `state.rules` | Tests: `state.test.json`

### membership

Role-based and claims-based access control.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `hasClaim(claim)` | claim: string | bool | Auth token has non-null value for claim key |
| `hasClaimRole(claim, role)` | claim: string, role: string | bool | Auth token claim matches specific role value |
| `isMemberOf(membersMap)` | membersMap: map field | bool | Auth uid exists as key in members map |
| `hasRole(membersMap, role)` | membersMap: map field, role: string | bool | Auth uid has specific role in members map |

File: `membership.rules` | Tests: `membership.test.json`

### storage/uploads

Storage upload-request limits over declared size and MIME metadata.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `sizeAtMost(maxBytes)` | maxBytes: int | bool | Incoming size is at most the inclusive byte limit |
| `sizeBetween(minBytes, maxBytes)` | min/max: int | bool | Incoming size is within the inclusive range |
| `contentTypeMatches(pattern)` | pattern: string | bool | Incoming MIME metadata matches the entire RE2 pattern |
| `contentTypeIsOneOf(types)` | types: list | bool | Incoming MIME metadata equals one allowlisted value |

These functions inspect metadata supplied with the object. They do not inspect
or authenticate file bytes, so they are upload-policy helpers—not content
validation.

File: `storage/uploads.rules` | Tests: `storage/uploads.test.json`

### storage/metadata

Custom-metadata shape and ownership helpers.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `hasRequiredMetadata(keys)` | keys: list | bool | Incoming custom metadata contains every required own key; extras are allowed |
| `metadataString(key, min, max)` | key: string, min/max: int | bool | Incoming value is a bounded string; missing keys deny |
| `incomingMetadataOwner(key)` | key: string | bool | Incoming metadata value equals the authenticated UID |
| `existingMetadataOwner(key)` | key: string | bool | Existing metadata value equals the authenticated UID |

File: `storage/metadata.rules` | Tests: `storage/metadata.test.json`

### storage/objects

Operation identity without unsafe missing-binding null checks.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isCreate()` | — | bool | `request.method == 'create'` |
| `isUpdate()` | — | bool | `request.method == 'update'` |
| `isDelete()` | — | bool | `request.method == 'delete'` |

File: `storage/objects.rules` | Tests: `storage/objects.test.json`

### storage/time

Strict freshness windows over server-owned existing-object timestamps.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `createdWithin(seconds)` | seconds: int | bool | Request time is strictly before creation time plus the window |
| `updatedWithin(seconds)` | seconds: int | bool | Request time is strictly before update time plus the window |

Equality with the deadline denies. These helpers require an existing object.

File: `storage/time.rules` | Tests: `storage/time.test.json`

### lifecycle

Field immutability and timestamp enforcement.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `fieldUnchanged(field)` | field: string | bool | Field value identical before and after write |
| `immutableFields(fields)` | fields: list of strings | bool | All listed fields unchanged (uses MapDiff, replaces chained fieldUnchanged) |
| `isServerTimestamp(field)` | field: string | bool | Field value equals `request.time` |
| `onlyFieldsChanged(fields)` | fields: list of strings | bool | Every changed field is in the list — the dual of immutableFields (unlisted fields implicitly immutable). Top-level keys only |
| `nFieldsChanged(n)` | n: int | bool | Exactly n top-level fields changed (n=1 = board-integrity / edit-one-field guard) |

File: `lifecycle.rules` | Tests: `lifecycle.test.json`

### transitions

State machine enforcement.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `validTransition(field, from, to)` | field: string, from: string, to: string | bool | Field transitions from one value to another |
| `statusIs(field, value)` | field: string, value: string | bool | Current (pre-write) field matches value |
| `newStatusIs(field, value)` | field: string, value: string | bool | Incoming (post-write) field matches value |

File: `transitions.rules` | Tests: `transitions.test.json`

### geometry

Movement game validation via config document lookup. Caller must pass the config data from a `get()` call — no implicit dependencies.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `validSimpleMove(cfg)` | cfg: config doc `.data` from `get()` | bool | `cfg.moves[piece][from][to] == true` — validates geometry for any piece type |
| `validJumpMove(cfg)` | cfg: config doc `.data` from `get()` | bool | `cfg.jumps[piece][from][to] == captured` — validates jump + captured cell |

**Usage**:
```
import { validSimpleMove, validJumpMove } from 'geometry';

function config() {
  return get(/databases/$(database)/documents/gameConfig/checkers).data;
}

// Pass config data explicitly
allow update: if validSimpleMove(config()) && piecePlaced() && moveIntegrity();
allow update: if validJumpMove(config()) && captureValid() && moveIntegrity();
```

**Config doc schema**: See Pattern 15 in PATTERNS.md. Keys: `moves[pieceType][from][to] = true`, `jumps[pieceType][from][to] = capturedCell`.

File: `geometry.rules` | Tests: `geometry.test.json`
Proven by lookup-doc, path-blocking, and checkers lookup validation probes.
Patterns: 12 (Config Document), 13 (Path Blocking), 14 (Piece-Type-Agnostic)

### counters

Denormalized numeric integrity (likes, votes, moves, quantities). Generalizes state's `moveIncremented()` to any field.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `incrementedBy(field, n)` | field: string, n: int | bool | Field changed by exactly n vs the existing doc (n may be negative). Update rules only |
| `changedBy(field, min, max)` | field: string, min/max: int | bool | Field's delta is within [min, max]; zero delta passes when the range spans 0 |
| `boundedNumber(field, min, max)` | field: string, min/max: number | bool | Incoming value is an int or float within [min, max]; missing field fails closed |

File: `counters.rules` | Tests: `counters.test.json`

### timing

Cooldown / rate-limit enforcement. Refutes the "rules cannot rate-limit" assumption (jrpg F-004) — verified against the production engine.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `cooldownElapsed(field, seconds)` | field: string (Timestamp field), seconds: int | bool | `request.time > resource.data[field] + duration.value(seconds, 's')` — the stored timestamp is strictly older than the window. Pair with `isServerTimestamp(field)` on the same write so the timestamp can't be forged |

Update rules only (needs `resource`). Missing / non-timestamp field errors → denies (fail-closed).

File: `timing.rules` | Tests: `timing.test.json`
Proven by a live Rules Test API validation probe; also records the RFC3339-coercion divergence between the live API and the simulator.

### content

Author-owned documents — posts, notes, docs, comments, tasks. Field names are parameters, not conventions.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `validAuthorCreate(authorField)` | authorField: string | bool | Signed in, and the incoming doc's author field is the caller. Create rules |
| `isAuthor(authorField)` | authorField: string | bool | Caller is the EXISTING doc's author. Update/delete rules |
| `canReadContent(statusField, authorField)` | statusField, authorField: string | bool | Published is public; anything else visible to its author only. `get` rules — list queries must prove `status == 'published'` via query filters (rules are not filters) |
| `notDeleted()` | — | bool | Soft-delete guard: `resource.data['deleted'] != true` (bracket access — null-on-miss, absent field passes) |

File: `content.rules` | Tests: `content.test.json`

### spaces

Cross-document membership gating for shared spaces (teams, rooms, groups, projects, parties): a PARENT document defines who may touch its children. Explicit param — the caller reads the parent doc once via a `space()` helper (`get()` is cached per request) and passes its `.data` in.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isSpaceMember(spaceData)` | spaceData: parent doc `.data` | bool | Caller's uid is in `spaceData.members` — covers BOTH list (`['a','b']`) and map (`{a:'admin'}`) shapes |
| `hasSpaceRole(spaceData, role)` | + role: string | bool | Caller's role in a MAP-shaped members field equals `role`; denies on list shape (no roles) |
| `validMemberCreate(spaceData, authorField)` | + authorField: string | bool | Member AND the incoming child doc's author field is the caller — the "post a message / add a task" guard |

Missing members field, non-member uid, and missing parent doc (get() errors) all fail CLOSED — production-verified.

File: `spaces.rules` | Tests: `spaces.test.json`
Proven by simulator and live Rules validation, including list-vs-map `in` semantics and role lookup.

### joining

How membership CHANGES, safely — self-service join/leave on a MAP-shaped members field with no privilege escalation. Compose with `lifecycle.onlyFieldsChanged(['members'])` so the write can't touch anything else, and with `spaces` for the read side.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `onlyAddedSelf(membersField, role)` | membersField, role: string | bool | The write adds EXACTLY the caller at EXACTLY `role` — nobody changed, nobody removed, no-op denied (set equality, not hasOnly) |
| `onlyRemovedSelf(membersField)` | membersField: string | bool | The write removes EXACTLY the caller — nobody added, nobody changed |

Production-verified 10/10 (field-level map diff IS reliable — the "nested diff unreliable" finding is about diffing through the document diff, not an explicit `.diff()` on two map values). Finding this vertical's semantics also uncovered and fixed a false-permissive simulator bug (FirestoreSet `==` was always true — RULES-B13, COMPAT row 136b).

Descoped to Patterns: single-use invite consumption (join + mark invite used atomically via batch write + `getAfter()`) — not expressible in either test engine's mock surface; needs real-database validation before it can meet the stdlib bar.

File: `joining.rules` | Tests: `joining.test.json`
Proven by simulator and live Rules validation after RULES-B13.

### atomic

Cross-document integrity for BATCH writes via the get()/getAfter() pair: "this write is valid only if a companion write happened in the same atomic batch". Denormalized counters, single-use invite consumption, paired documents.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `companionChangedBy(before, after, field, n)` | before/after: the companion doc's get()/getAfter() data | bool | The companion's field changed by EXACTLY n in this batch; a solo write denies (after == before) |
| `consumedFlag(before, after, flagField)` | + flagField: string | bool | Single-use consumption: pre-batch false AND post-batch true — replays deny (already true), solo writes deny |

Live-verified against a REAL production database (rules deployed, batch commits as a signed-in user, rules restored byte-identical): companion visibility, solo/wrong-delta denial, single-use + replay denial, and out-of-batch getAfter() == get() fallback (which matches the simulator's fallthrough — the sim's only gap is IN-batch companions, so fixtures test the function bodies with explicit map literals and live validation owns the wiring).

Remember: every write in a batch is evaluated — companion writes need their own allow rules.

File: `atomic.rules` | Tests: `atomic.test.json`
Proven by a real-DB validation matrix.

## Audit Process

When new patterns or approaches are discovered:

1. **Check this manifest** — does an existing module need updating? Is anything obsolete?
2. **Evaluate for stdlib** — is the function reusable across games/apps, or game-specific?
3. **Choose dependency type** — prefer self-contained. If external data is needed, use explicit parameters (never implicit hooks).
4. **Add .rules + .test.json** — every module must have both. Firestore
   fixtures are executed by `test/rules/modules/stdlib-cases.test.ts`; Storage
   fixtures are executed by `test/storage/stdlib-cases.test.ts` (every case must decide
   ALLOW/DENY as expected; UNSUPPORTED is a hard failure). Cases whose
   rules call `get()`/`exists()` must carry `functionMocks` so the
   fixture is self-contained.
5. **Verify against production** — run a live v1 scope test (real database, not Rules Test API). Record the v1 scope file name in the manifest.
6. **Update this manifest** — add the module, update the audit date.

### Stdlib vs Pattern vs Asset

| Where | What belongs there | Example |
|-------|-------------------|---------|
| **Stdlib module** | Reusable function, works across games/apps | `isMyTurn()`, `validSimpleMove(cfg)` |
| **Pattern** (PATTERNS.md) | Technique/approach agents need to understand | Config document pattern, path blocking |
| **Asset** (generator) | Reference implementation for a specific game | `checkers-lookup-generator.ts` |

Rule of thumb: if you'd copy-paste it into every game, it's stdlib. If you'd adapt it per game, it's a pattern. If it's a complete working example, it's an asset.
