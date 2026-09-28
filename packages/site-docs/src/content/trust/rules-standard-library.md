---
title: "Rules standard library reference"
group: "Trust"
section: ""
order: 41
description: "Service compatibility, evidence level, and function reference for every bundled Rules module."
---

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

| Module | Services | Dependency | Pattern | Verified |
|--------|----------|------------|---------|----------|
| [auth](#auth) | Firestore + Storage | Self-contained | — | Firestore + Storage production |
| [validation](#validation) | Firestore | Self-contained | — | Simulator |
| [lobby](#lobby) | Firestore | Self-contained | — | Simulator + Rules Test API replay |
| [turns](#turns) | Firestore | Self-contained | — | Simulator + Rules Test API replay |
| [state](#state) | Firestore | Self-contained | — | Simulator |
| [results](#results) | Firestore | Imports modules | — | Simulator + Rules Test API replay |
| [fairness](#fairness) | Firestore | Self-contained | — | Simulator + Rules Test API replay |
| [membership](#membership) | Firestore + Storage | Self-contained | — | Firestore + Storage production |
| [storage/uploads](#storageuploads) | Storage | Self-contained | — | Storage evaluator + production oracle |
| [storage/metadata](#storagemetadata) | Storage | Self-contained | — | Storage evaluator + production oracle |
| [storage/objects](#storageobjects) | Storage | Self-contained | — | Storage evaluator + production oracle |
| [storage/time](#storagetime) | Storage | Self-contained | — | Storage evaluator + production oracle |
| [lifecycle](#lifecycle) | Firestore | Self-contained | — | Simulator + Rules Test API replay |
| [transitions](#transitions) | Firestore | Self-contained | — | Simulator |
| [geometry](#geometry) | Firestore | Explicit param | Patterns 12-14 | Simulator + live Rules validation + Rules Test API replay |
| [counters](#counters) | Firestore | Self-contained | — | Simulator + Rules Test API replay |
| [timing](#timing) | Firestore | Self-contained | — | Simulator + live Rules validation |
| [content](#content) | Firestore | Self-contained | — | Simulator + Rules Test API replay |
| [spaces](#spaces) | Firestore | Explicit param | — | Simulator + live Rules validation |
| [joining](#joining) | Firestore | Self-contained | — | Simulator + live Rules validation |
| [atomic](#atomic) | Firestore | Explicit param | — | Simulator bodies + live real-DB validation |

## Dependency Types

- **Self-contained**: Only references `request`, `resource`, `request.auth`. No user-defined functions needed.
- **Explicit param**: Requires caller to pass data (e.g., config doc result) as a function parameter. No implicit dependencies.
- **Imports modules**: Calls functions from other bundled modules. The resolver inlines them, so you import only the module you use.

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

Game session lifecycle (create, join, cancel, rematch).

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `validCreate()` | — | bool | Host is auth user, guest empty, status waiting |
| `validJoin()` | — | bool | Guest slot empty, joiner is not host, status → playing |
| `canCancel()` | — | bool | Status is waiting, requester is host |
| `validRematch(previousPath)` | previousPath: path to the finished match | bool | The match at the path is 'won', 'draw' or 'resigned' and seated the caller as host or guest; the new match has the caller as host, guest '' and status waiting. Reads 1 |

Convention: uses `host`/`guest`/`status` fields on document. A rematch opens like any other lobby: the player who asks hosts it, so the seats swap when the guest asks, and the other player joins through `validJoin`. Tic-tac-toe, Chess and Reversi start their rematches this way. A missing previous match is an error and denies the request.

File: `lobby.rules` | Tests: `lobby.test.json`
Every case replayed through the Rules Test API with the same decision.

### turns

Turn enforcement for two-player games and for games with a seat list.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isMyTurn()` | — | bool | Current player matches auth uid (host/guest) |
| `turnFlipped()` | — | bool | currentTurn alternates between host and guest |
| `isSeatTurn(seats, turnIndex)` | seats: list of UIDs, turnIndex: int | bool | Caller is signed in and `seats[turnIndex] == request.auth.uid`; an index out of range is an error and denies |
| `turnAdvanced(seatCount)` | seatCount: int | bool | New `turn` is `(turn + 1) % seatCount` (the last seat wraps to 0) and `players` is unchanged |

Convention: `isMyTurn` and `turnFlipped` use `host`/`guest`/`currentTurn` fields on document. `turnAdvanced` uses `players` (UIDs in turn order) and `turn` (int index of the seat on turn); `isSeatTurn` takes both as arguments.

File: `turns.rules` | Tests: `turns.test.json`
Every case replayed through the Rules Test API with the same decision.

### state

Game state tracking.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isPlaying()` | — | bool | `resource.data.status == 'playing'` |
| `moveIncremented()` | — | bool | moveCount increased by exactly 1 |
| `participantsUnchanged()` | — | bool | host and guest fields unchanged |

File: `state.rules` | Tests: `state.test.json`

### results

How a two-player game ends, and that other writes leave the result alone.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `resignedBy(seat)` | seat: 'host' or 'guest' | bool | The caller holds the seat, status goes from 'playing' to 'resigned', the other seat wins, only status and winner change |
| `finishedWithWinner(winner, reason)` | winner: 'host', 'guest' or ''; reason: 'won' or 'draw' | bool | Status goes from 'playing' to the reason, winner is a seat for 'won' and '' for 'draw', only status and winner change |
| `resultUnchanged()` | — | bool | Status and winner unchanged |

Convention: uses `host`/`guest`/`status`/`winner` fields on document. The status names how the game ended ('won', 'draw' or 'resigned'), so there is no separate reason field. `finishedWithWinner` does not check the caller; compose it with the rule that decides who may record a result.

Imports `onlyFieldsChanged` and `immutableFields` from `lifecycle`, `statusIs` and `newStatusIs` from `transitions`.

File: `results.rules` | Tests: `results.test.json`
Every case replayed through the Rules Test API with the same decision.

### fairness

Commit-reveal checks for hidden choices and shared randomness.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `commitmentMatches(commitment, salt)` | commitment: uppercase hex string; salt: string | bool | The salt is a non-empty string and its SHA-256, as uppercase hex, equals the commitment |
| `digestByte(digest, index)` | digest: Bytes; index: int | int | Byte `index` of the digest, 0 to 255; an index outside the digest or a digest that is not Bytes is an error, so the rule denies |

Convention: the commit write stores `commit`, the string `hashing.sha256(salt).toHexString()` produces, and the reveal write stores `salt`. A commitment stored as Bytes or as lowercase hex does not match. An empty salt is refused because anyone can compute its digest.

Production Bytes have no index operator, so `digestByte` reads the byte from `toHexString()` through a 16-entry lookup map, 63 expressions per call. A die face is `digestByte(d, i) % 6 + 1`; faces 1 to 4 come up 43 times in 256 and faces 5 and 6 come up 42 times.

File: `fairness.rules` | Tests: `fairness.test.json`
Every case replayed through the Rules Test API with the same decision.

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

Operation identity without unsafe missing-binding null checks, and checks on
the object name.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `isCreate()` | — | bool | `request.method == 'create'` |
| `isUpdate()` | — | bool | `request.method == 'update'` |
| `isDelete()` | — | bool | `request.method == 'delete'` |
| `nameSegment(index)` | index: int | string | Segment `index` of the object name split on `/`, counting from 0; an index past the last segment denies |
| `matchesDocument(path, field)` | path: path, field: string | bool | The caller is signed in, and the Firestore document at `path` exists and its `field` equals the object name. Reads 1 document |

The object name is the full path within the bucket. On create and update it
comes from `request.resource.name`, because a create may have no stored object.
On get and delete it comes from `resource.name`, because those requests carry
no incoming object. A Storage rule reads at most two distinct Firestore
documents, so a rule can call `matchesDocument` at most twice with different
paths.

File: `storage/objects.rules` | Tests: `storage/objects.test.json` | Production replay:
`test/rules/modules/fixtures/stdlib-replay-storage-objects.json` (Rules Test API)

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
| `exactlyChanged(keys)` | keys: list or set of strings | bool | The changed top-level fields are exactly `keys`: every listed field changed and no other field did |

`onlyFieldsChanged` checks that the changed fields are a subset of the list, so a listed field may stay unchanged. `exactlyChanged` checks that they equal the list. Use `exactlyChanged` for a transition that always writes the same fields, such as a tic-tac-toe move, and `onlyFieldsChanged` when some listed fields change only sometimes, such as `status` and `winner` on a move that may end the game. Adds and removes count as changes. Both read `resource.data`, so on create the call is an error and the rule denies.

File: `lifecycle.rules` | Tests: `lifecycle.test.json`
Every case replayed through the Rules Test API with the same decision.

### transitions

State machine enforcement.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `validTransition(field, from, to)` | field: string, from: string, to: string | bool | Field transitions from one value to another |
| `statusIs(field, value)` | field: string, value: string | bool | Current (pre-write) field matches value |
| `newStatusIs(field, value)` | field: string, value: string | bool | Incoming (post-write) field matches value |

File: `transitions.rules` | Tests: `transitions.test.json`

### geometry

Movement game validation via config document lookup, and arithmetic on named squares. Caller must pass the config data from a `get()` call, with no implicit dependencies.

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

Named squares, on an 8 by 8 board: a square is a file letter `'a'` to `'h'` followed by a rank digit `'1'` to `'8'`.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `file(square)` | square: string | int | File as a number, `'a'` is 1 and `'h'` is 8. A malformed square is an error |
| `rank(square)` | square: string | int | Second character read as a digit. A non-digit is an error |
| `step(square, df, dr)` | square: string, df/dr: int | string | Square `df` files and `dr` ranks away. Off the board in any direction is an error |
| `inBounds(square)` | square: any | bool | String of one file letter and one rank digit. False for anything else, a non-string included |

`file`, `rank`, and `step` read a square without checking it, and `rank('e9')` is 9. Check a client-written square with `inBounds` first.

Each named-square function was measured against the same check written inline, with the same padding measurement against production:

| Check | With `geometry` | Written inline |
|---|---|---|
| File of a square | `file`: 23 | map lookup on `sq[0:1]`: 23 |
| Rank of a square | `rank`: 6 | `int(sq[1:2])`: 6 |
| `to` is `df` files and `dr` ranks from `from` | `step(from, df, dr) == to`: 51 | file and rank differences: 53 to 71 |
| Square is on the board | `inBounds`: 5 to 9 | range check on an int cell: 6 to 14 |

To test for any one diagonal neighbor, file and rank differences cost 73 to 145, and four `step` calls cost more.

File: `geometry.rules` | Tests: `geometry.test.json`
Proven by lookup-doc, path-blocking, and checkers lookup validation probes. Every case replayed through the Rules Test API with the same decision.
Patterns: 12 (Config Document), 13 (Path Blocking), 14 (Piece-Type-Agnostic)

### counters

Denormalized numeric integrity (likes, votes, moves, quantities) and best scores. Generalizes state's `moveIncremented()` to any field.

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `incrementedBy(field, n)` | field: string, n: int | bool | Field changed by exactly n vs the existing doc (n may be negative). Update rules only |
| `changedBy(field, min, max)` | field: string, min/max: int | bool | Field's delta is within [min, max]; zero delta passes when the range spans 0 |
| `boundedNumber(field, min, max)` | field: string, min/max: number | bool | Incoming value is an int or float within [min, max]; missing field fails closed |
| `improvedBy(field, direction, mayChange)` | field: string, direction: `'up'` or `'down'`, mayChange: list of strings | bool | Field moved strictly in `direction` and every other changed top-level field is in `mayChange`. Update rules only |

`improvedBy` needs an int or a float on both sides and compares them by value, as production compares an int with a float. An unchanged or worse value, a string or missing value on either side, an unlisted field added, removed, or changed, and any other direction deny. A field in `mayChange` may stay unchanged.

File: `counters.rules` | Tests: `counters.test.json`
Every case replayed through the Rules Test API with the same decision.

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
| `notDeleted()` | — | bool | Soft-delete guard: `resource.data.get('deleted', false) != true`. An absent field passes, because `get()` returns the default; bracket access of a missing key is an error in production |
| `ownerOnlyUntil(parentPath, ownerUid, statuses)` | parentPath: path to the match, ownerUid: string, statuses: list | bool | Hidden per-player document: the owner reads it at any time; any other signed-in caller reads it once the match's `status` is in `statuses`. The owner check runs before the `get()`, so the owner's read spends none. Reads 1 |

Convention for `ownerOnlyUntil`: the hidden document lives at `{collection}/{matchId}/{sub}/{uid}` under a match document with a `status` field. Pass the `uid` wildcard as the owner when the document id is the owner's UID, or `resource.data.<field>` when the owner is a field. A missing match is an error and denies every caller but the owner.

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

Promoted through [`atomic`](#atomic): single-use invite consumption (join + mark invite used atomically via batch write + `getAfter()`) is not expressible in either test engine's mock surface, so real-database validation now owns that wiring contract.

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
5. **Verify the claim with the right oracle** — for pure function bodies, use
   exact Rules Test API cases plus an AST source lock and local replay. For
   resource-dependent claims (real documents or objects, IAM, lookup budgets,
   caching, or consistency), deploy a bounded live v1 resource probe, restore
   the prior release, and verify cleanup. Record the evidence in the manifest.
6. **Update this manifest** — add the module, update the audit date.

### Stdlib vs Pattern vs Asset

| Where | What belongs there | Example |
|-------|-------------------|---------|
| **Stdlib module** | Reusable function, works across games/apps | `isMyTurn()`, `validSimpleMove(cfg)` |
| **Pattern** (PATTERNS.md) | Technique/approach agents need to understand | Config document pattern, path blocking |
| **Asset** (generator) | Reference implementation for a specific game | `checkers-lookup-generator.ts` |

Rule of thumb: if you'd copy-paste it into every game, it's stdlib. If you'd adapt it per game, it's a pattern. If it's a complete working example, it's an asset.
