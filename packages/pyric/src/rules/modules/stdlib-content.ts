/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate via `bun run inline-stdlib` (or `bun run build`, which
 * runs the generator as part of `prebuild`).
 *
 * Mirror of every `.rules` file under `src/rules/modules/stdlib/`,
 * inlined as TypeScript string literals so the resolver can run
 * in the browser. See `scripts/inline-stdlib.ts`.
 */

export const STDLIB_INLINE: Record<string, string> = {
  "atomic": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Atomic module — cross-document integrity for BATCH writes, via the
// get()/getAfter() pair. Firestore evaluates every write in a batch
// against rules, and getAfter() returns another document's POST-BATCH
// state — so a rule can require "this write is only valid if a
// companion write happened in the same atomic batch".
//
// All semantics live-verified against a production database: companion
// visibility, solo-write denial, wrong-delta denial, single-use consumption
// incl. replay denial, and out-of-batch getAfter() falling back to current
// state.
//
// Explicit-param design: pass BOTH states of the companion doc —
// \`get(path).data\` (pre-batch) and \`getAfter(path).data\` (post-batch).
//
//   import { companionChangedBy, consumedFlag } from 'atomic';
//
//   // Denormalized counter: creating a task REQUIRES the team's
//   // taskCount to have been incremented in the same batch:
//   match /teams/{teamId}/tasks/{taskId} {
//     function teamBefore() {
//       return get(/databases/$(database)/documents/teams/$(teamId)).data;
//     }
//     function teamAfter() {
//       return getAfter(/databases/$(database)/documents/teams/$(teamId)).data;
//     }
//     allow create: if companionChangedBy(teamBefore(), teamAfter(), 'taskCount', 1);
//   }
//
//   // Single-use invite: the join is valid only when the invite was
//   // consumed (false -> true) IN THIS BATCH — replays deny because
//   // the pre-batch state is already true:
//   allow update: if consumedFlag(inviteBefore(), inviteAfter(), 'used');
//
// NOTE (simulator): in-batch companion semantics cannot be expressed
// in the simulator or the Rules Test API mock surface — the simulator
// treats cross-doc getAfter() as get(). These function BODIES are
// simulator-tested with explicit values; the getAfter() WIRING is the
// live v1 scope's job. Companion writes need their own allow rules too —
// every write in a batch is evaluated.

// The companion doc's field changed by EXACTLY n in this batch.
// before/after are the SAME doc's get()/getAfter() data.
// cost 10 to 10 expressions per call
export function companionChangedBy(before, after, field, n) {
  return after[field] == before[field] + n;
}

// A single-use flag was consumed IN THIS BATCH: pre-batch false,
// post-batch true. Replays deny (pre-batch is already true), and a
// solo write denies (getAfter == get, so false != true).
// cost 7 to 13 expressions per call
export function consumedFlag(before, after, flagField) {
  return before[flagField] == false && after[flagField] == true;
}
`,
  "auth": `// @pyric-services cloud.firestore,firebase.storage
// @pyric-evidence storage-rules#125,firestore-rules#189
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// cost 5 to 5 expressions per call
export function isAuthenticated() {
  return request.auth != null;
}

// cost 7 to 13 expressions per call
export function isOwner(userId) {
  return isAuthenticated() && request.auth.uid == userId;
}
`,
  "content": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Content module for author-owned documents — the most common
// Firebase app shape (posts, notes, docs, comments, tasks).
//
// Convention: documents carry an author field (a UID string) and
// usually a status field ('draft' | 'published' | ...). Field names
// are parameters, not conventions — pass yours.
//
// Usage:
//   import { validAuthorCreate, isAuthor, canReadContent, notDeleted } from 'content';
//   import { onlyFieldsChanged } from 'lifecycle';
//
//   match /posts/{postId} {
//     // Create: author is the signed-in user.
//     allow create: if validAuthorCreate('author');
//     // Read: published to everyone, drafts to the author only.
//     allow read: if canReadContent('status', 'author') && notDeleted();
//     // Update: author edits content fields; authorship immutable.
//     allow update: if isAuthor('author') && onlyFieldsChanged(['title', 'body', 'status']);
//     allow delete: if isAuthor('author');
//   }

// Create guard: signed in, and the incoming doc's author field is the
// caller. Use on \`create\` (reads request.resource).
// cost 6 to 16 expressions per call
export function validAuthorCreate(authorField) {
  return request.auth != null
    && request.resource.data[authorField] == request.auth.uid;
}

// The caller is the EXISTING document's author. Use on update/delete
// (reads resource).
// cost 6 to 15 expressions per call
export function isAuthor(authorField) {
  return request.auth != null
    && resource.data[authorField] == request.auth.uid;
}

// Read visibility: published content is public; anything else is
// visible to its author only. Works for get; for list queries the
// client must filter (rules are not filters — a bare collection query
// will be denied unless it proves status == 'published').
// cost 8 to 23 expressions per call
export function canReadContent(statusField, authorField) {
  return resource.data[statusField] == 'published'
    || (request.auth != null && resource.data[authorField] == request.auth.uid);
}

// Soft-delete guard: the document is not marked deleted. Reads the
// EXISTING doc; a doc without the field passes — bracket access is
// the null-on-miss idiom (dotted access of a missing key ERRORS).
// cost 7 to 7 expressions per call
export function notDeleted() {
  return resource.data['deleted'] != true;
}
`,
  "counters": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Counters module for denormalized numeric integrity.
//
// The recurring shape: a client-maintained count (likes, votes, moves,
// quantities) that rules must keep honest — it may only change by a
// known step, or stay within known bounds. Generalizes the
// state-module's moveIncremented() (hardcoded to moveCount) to any
// field.
//
// Usage:
//   import { incrementedBy, changedBy, boundedNumber } from 'counters';
//
//   // A like toggle: likeCount moves by exactly ±1:
//   allow update: if changedBy('likeCount', -1, 1);
//
//   // A move counter: strictly +1 per move:
//   allow update: if incrementedBy('moveCount', 1);
//
//   // A rating: any write keeps it in [1, 5]:
//   allow write: if boundedNumber('rating', 1, 5);

// The field changed by EXACTLY n relative to the existing document.
// n may be negative (decrement). Update rules only (needs resource).
// cost 13 to 13 expressions per call
export function incrementedBy(field, n) {
  return request.resource.data[field] == resource.data[field] + n;
}

// The field's delta is within [min, max] (inclusive) — and it is NOT
// required to change (delta 0 passes when min <= 0 <= max).
// cost 14 to 27 expressions per call
export function changedBy(field, min, max) {
  return request.resource.data[field] - resource.data[field] >= min
    && request.resource.data[field] - resource.data[field] <= max;
}

// The incoming value is a number within [min, max] (inclusive).
// Works on create and update. Missing field reads null (dynamic
// access) and fails the type check rather than erroring.
// cost 19 to 35 expressions per call
export function boundedNumber(field, min, max) {
  return (request.resource.data[field] is int || request.resource.data[field] is float)
    && request.resource.data[field] >= min
    && request.resource.data[field] <= max;
}
`,
  "geometry": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Geometry module for movement game validation via config document lookup.
//
// Caller must pass the config document data as an explicit parameter.
// The config doc is read via get() and cached per request — define a
// config() function in your rules and pass its result to these functions.
//
// Config doc schema:
//   moves[pieceType][fromCell][toCell] = true
//   jumps[pieceType][fromCell][toCell] = capturedCellName
//
// Usage:
//   import { validSimpleMove, validJumpMove } from 'geometry';
//
//   function config() {
//     return get(/databases/$(database)/documents/gameConfig/checkers).data;
//   }
//
//   allow update: if validSimpleMove(config())
//     && piecePlaced() && moveIntegrity();
//
//   allow update: if validJumpMove(config())
//     && captureValid() && captureDecrement() && moveIntegrity();

// Validate a simple (non-capture) move via config document lookup.
// Uses 3-level dynamic nesting: cfg.moves[piece][from][to].
// piece comes from resource.data (pre-write board) so client can't fake it.
// cost 26 to 26 expressions per call
export function validSimpleMove(cfg) {
  let mf = request.resource.data.moveFrom;
  let mt = request.resource.data.moveTo;
  let piece = resource.data[mf];
  return cfg.moves[piece][mf][mt] == true;
}

// Validate a jump (capture) move via config document lookup.
// cfg.jumps[piece][from][to] returns the expected captured cell name.
// Caller must separately verify the captured piece is an opponent piece.
// cost 31 to 31 expressions per call
export function validJumpMove(cfg) {
  let mf = request.resource.data.moveFrom;
  let mt = request.resource.data.moveTo;
  let cap = request.resource.data.captured;
  let piece = resource.data[mf];
  return cfg.jumps[piece][mf][mt] == cap;
}
`,
  "joining": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Joining module — how membership CHANGES, safely. The connective
// tissue between content/spaces: spaces gates children behind a
// members field; joining lets users enter and leave that field
// WITHOUT an admin backend, with no privilege escalation.
//
// Convention: a MAP-shaped members field (uid -> role) on the parent
// doc. Compose with lifecycle's onlyFieldsChanged so a join/leave
// write can't touch anything else:
//
//   import { onlyAddedSelf, onlyRemovedSelf } from 'joining';
//   import { onlyFieldsChanged } from 'lifecycle';
//   import { isSpaceMember, hasSpaceRole } from 'spaces';
//
//   match /teams/{teamId} {
//     allow read: if isSpaceMember(resource.data);
//
//     // Open self-service join (public team) at a fixed role, and
//     // self-service leave — nothing else about the doc may change:
//     allow update: if onlyFieldsChanged(['members'])
//       && (onlyAddedSelf('members', 'editor') || onlyRemovedSelf('members'));
//     // Admins manage the doc freely:
//     allow update: if hasSpaceRole(resource.data, 'admin');
//   }
//
// Every guarantee here is production-verified against the live Rules Test API:
// the field-level map diff is reliable; the empty no-op diff DENIES (set
// equality, not hasOnly — hasOnly on an empty set passes); role escalation via
// CHANGING an existing entry denies; adding or removing anyone else denies.

// The write adds EXACTLY the caller to the members map, at EXACTLY
// \`role\`, changing and removing nobody. Update rules only.
// cost 20 to 53 expressions per call
export function onlyAddedSelf(membersField, role) {
  let diff = request.resource.data[membersField].diff(resource.data[membersField]);
  return request.auth != null
    && diff.addedKeys() == [request.auth.uid].toSet()
    && diff.changedKeys().size() == 0
    && diff.removedKeys().size() == 0
    && request.resource.data[membersField][request.auth.uid] == role;
}

// The write removes EXACTLY the caller from the members map, adding
// and changing nobody. Self-service leave. Update rules only.
// cost 19 to 40 expressions per call
export function onlyRemovedSelf(membersField) {
  let diff = request.resource.data[membersField].diff(resource.data[membersField]);
  return request.auth != null
    && diff.removedKeys() == [request.auth.uid].toSet()
    && diff.addedKeys().size() == 0
    && diff.changedKeys().size() == 0;
}
`,
  "lifecycle": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Lifecycle module for field immutability and timestamp enforcement.
//
// Common pattern: certain fields must never change after document creation
// (createdBy, createdAt, authorId).
//
// Usage:
//   import { fieldUnchanged, immutableFields, isServerTimestamp } from 'lifecycle';
//
//   // Single field:
//   allow update: if fieldUnchanged('createdBy');
//
//   // Multiple fields (replaces chained fieldUnchanged calls):
//   allow update: if immutableFields(['createdBy', 'createdAt', 'authorId']);
//
//   // The dual: users may edit title/body but NOTHING else:
//   allow update: if onlyFieldsChanged(['title', 'body']);
//
//   allow create: if isServerTimestamp('createdAt');

// Ensure a field's value is identical between existing and incoming document.
// Use on update rules to enforce immutability.
// cost 11 to 11 expressions per call
export function fieldUnchanged(field) {
  return resource.data[field] == request.resource.data[field];
}

// Ensure multiple fields are unchanged between existing and incoming document.
// Uses MapDiff — one expression instead of N chained fieldUnchanged() calls.
// cost 10 to 10 expressions per call
export function immutableFields(fields) {
  return request.resource.data.diff(resource.data).unchangedKeys().hasAll(fields);
}

// Ensure a field is set to the server timestamp.
// Use on create or update rules to enforce server-side time.
// cost 9 to 9 expressions per call
export function isServerTimestamp(field) {
  return request.resource.data[field] == request.time;
}

// The dual of immutableFields: every changed field is in the allowed
// list (fields NOT listed are implicitly immutable). Top-level keys
// only — nested-map diffs are unreliable in production; flatten the
// schema instead of reaching for a nested diff.
// cost 10 to 10 expressions per call
export function onlyFieldsChanged(fields) {
  return request.resource.data.diff(resource.data).affectedKeys().hasOnly(fields);
}

// Exactly n top-level fields changed in this write. n == 1 is the
// board-integrity / edit-one-field-per-write guard (Pattern 5,
// generalized beyond games).
// cost 11 to 11 expressions per call
export function nFieldsChanged(n) {
  return request.resource.data.diff(resource.data).affectedKeys().size() == n;
}
`,
  "lobby": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Lobby module for 2-participant coordination.
//
// Convention: documents must have these fields:
//   host: string (creator's UID)
//   guest: string ('' when waiting, joiner's UID when joined)
//   status: 'waiting' | 'playing' | 'ready' (or any active state)
//
// Usage:
//   import { validCreate, validJoin, canCancel } from 'lobby';
//
//   allow create: if validCreate();
//   allow update: if validJoin();
//   allow delete: if canCancel();

// Is this a waiting lobby with an open seat?
function isWaiting() {
  return resource.data.status == 'waiting'
    && resource.data.guest == '';
}

// Create: caller is host, seat empty, status waiting
// cost 8 to 31 expressions per call
export function validCreate() {
  return request.auth != null
    && request.resource.data.host == request.auth.uid
    && request.resource.data.guest == ''
    && request.resource.data.status == 'waiting';
}

// Join: fill empty seat, transition to next status, no self-join
// cost 10 to 57 expressions per call
export function validJoin() {
  return request.auth != null
    && isWaiting()
    && request.resource.data.guest == request.auth.uid
    && request.auth.uid != resource.data.host
    && request.resource.data.status == 'playing'
    && request.resource.data.host == resource.data.host;
}

// Cancel: only host, only while waiting
// cost 7 to 21 expressions per call
export function canCancel() {
  return request.auth != null
    && resource.data.status == 'waiting'
    && request.auth.uid == resource.data.host;
}
`,
  "membership": `// @pyric-services cloud.firestore,firebase.storage
// @pyric-evidence storage-rules#125,firestore-rules#189
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Membership module for role-based and claims-based access control.
//
// Two access patterns:
//   1. Custom claims on auth token (0 get() calls, set server-side)
//   2. Member maps on documents (0 get() calls on the doc itself)
//
// Usage:
//   import { hasClaim, hasClaimRole, isMemberOf, hasRole } from 'membership';
//
//   // Workspace access via custom claims
//   allow read: if hasClaim('workspace_id');
//   allow write: if hasClaimRole('workspace_role', 'admin');
//
//   // Project access via member map on document
//   allow read: if isMemberOf(resource.data.members);
//   allow update: if hasRole(resource.data.members, 'admin');

// Check if the auth token has a non-null value for a claim key.
// cost 6 to 14 expressions per call
export function hasClaim(claim) {
  return request.auth != null
    && request.auth.token[claim] != null;
}

// Check if the auth token has a specific value for a claim key.
// cost 6 to 14 expressions per call
export function hasClaimRole(claim, role) {
  return request.auth != null
    && request.auth.token[claim] == role;
}

// Check if the caller's UID exists as a key in a members map.
// cost 6 to 12 expressions per call
export function isMemberOf(membersMap) {
  return request.auth != null
    && request.auth.uid in membersMap;
}

// Check if the caller has a specific role in a members map.
// cost 6 to 14 expressions per call
export function hasRole(membersMap, role) {
  return request.auth != null
    && membersMap[request.auth.uid] == role;
}
`,
  "results": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Game results for 2-participant games/sessions: how a game in play ends,
// and that other writes leave the result alone.
//
// Convention: documents must have these fields:
//   host: string (UID)
//   guest: string (UID)
//   status: 'playing' while in play; 'won' | 'draw' | 'resigned' once finished
//   winner: 'host' | 'guest' on 'won' and 'resigned'; '' while playing and on 'draw'
//
// The status names how the game ended, so a result needs no separate reason
// field. This is the shape the 2-player turn games share: a resignation is
// status 'resigned' with the other seat as winner, a win is 'won' with the
// winning seat, and a draw is 'draw' with winner ''.
//
// Usage:
//   import { resignedBy, finishedWithWinner, resultUnchanged } from 'results';
//
//   // The caller resigns their own seat:
//   allow update: if resignedBy(request.auth.uid == resource.data.host ? 'host' : 'guest');
//
//   // A finish write names the winner and how the game ended:
//   allow update: if finishedWithWinner('host', 'won');
//
//   // Every other update leaves the result alone:
//   allow update: if resultUnchanged() && isMyTurn();

import { onlyFieldsChanged, immutableFields } from 'lifecycle';
import { statusIs, newStatusIs } from 'transitions';

// The caller holds \`seat\` ('host' or 'guest') and resigns: status goes from
// 'playing' to 'resigned', the other seat wins, and only status and winner
// change. The auth check comes first so a signed-out request stops there
// instead of evaluating every clause after the null uid.
// cost 10 to 72 expressions per call
export function resignedBy(seat) {
  return request.auth != null
    && ((seat == 'host' && request.resource.data.winner == 'guest')
        || (seat == 'guest' && request.resource.data.winner == 'host'))
    && resource.data[seat] == request.auth.uid
    && statusIs('status', 'playing')
    && newStatusIs('status', 'resigned')
    && onlyFieldsChanged(['status', 'winner']);
}

// A game in play finishes: status goes from 'playing' to \`reason\`, 'won' or
// 'draw'. \`winner\` is 'host' or 'guest' for 'won' and '' for 'draw', and
// only status and winner change. Resignations go through resignedBy, which
// also checks the caller.
// cost 14 to 61 expressions per call
export function finishedWithWinner(winner, reason) {
  return statusIs('status', 'playing')
    && ((reason == 'won' && winner in ['host', 'guest'])
        || (reason == 'draw' && winner == ''))
    && newStatusIs('status', reason)
    && request.resource.data.winner == winner
    && onlyFieldsChanged(['status', 'winner']);
}

// The write keeps the result: status and winner are unchanged. Use on every
// update that is not a finish.
// cost 14 to 14 expressions per call
export function resultUnchanged() {
  return immutableFields(['status', 'winner']);
}
`,
  "spaces": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Spaces module — cross-document membership gating for shared spaces
// (teams, rooms, groups, projects, parties). The second-most-common
// app shape after author-owned content: a PARENT document defines who
// may touch its children.
//
// Explicit-param design (like geometry): the caller reads the parent
// doc ONCE via a helper and passes its data in. Define the helper in
// your rules — get() is cached per request, so every function below
// can share one read (of the 10-get budget):
//
//   import { isSpaceMember, hasSpaceRole, validMemberCreate } from 'spaces';
//
//   match /spaces/{spaceId}/tasks/{taskId} {
//     function space() {
//       return get(/databases/$(database)/documents/spaces/$(spaceId)).data;
//     }
//     allow read: if isSpaceMember(space());
//     allow create: if validMemberCreate(space(), 'author');
//     allow delete: if hasSpaceRole(space(), 'admin');
//   }
//
// Members field shapes verified against the production engine:
//   list: members: ['uidA', 'uidB']            → isSpaceMember only
//   map:  members: { uidA: 'admin', ... }      → isSpaceMember + hasSpaceRole
// A missing members field, a non-member uid, or a missing parent doc
// (get() of a missing doc errors) all fail CLOSED.

// The caller is in the space's members field. \`in\` covers both
// shapes: list membership and map keys.
// cost 6 to 13 expressions per call
export function isSpaceMember(spaceData) {
  return request.auth != null && request.auth.uid in spaceData.members;
}

// The caller's role in a MAP-shaped members field equals \`role\`.
// List-shaped members carry no roles — this denies on them.
// cost 6 to 15 expressions per call
export function hasSpaceRole(spaceData, role) {
  return request.auth != null && spaceData.members[request.auth.uid] == role;
}

// Member-gated authored create: the caller is a member AND the
// incoming child doc's author field is the caller. The "post a
// message / add a task" guard.
// cost 9 to 26 expressions per call
export function validMemberCreate(spaceData, authorField) {
  return isSpaceMember(spaceData)
    && request.resource.data[authorField] == request.auth.uid;
}
`,
  "state": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Game state machine helpers.
//
// Convention: documents must have these fields:
//   status: 'waiting' | 'playing' | 'won' | 'draw'
//   moveCount: number
//   host: string (UID)
//   guest: string (UID)
//
// Usage:
//   import { isPlaying, moveIncremented, participantsUnchanged } from 'state';
//
//   allow update: if isPlaying() && moveIncremented() && participantsUnchanged();

// Is the game actively in play?
// cost 6 to 6 expressions per call
export function isPlaying() {
  return resource.data.status == 'playing';
}

// Did moveCount increment by exactly 1?
// cost 11 to 11 expressions per call
export function moveIncremented() {
  return request.resource.data.moveCount == resource.data.moveCount + 1;
}

// Are host and guest unchanged? (prevents mid-game identity swap)
// cost 10 to 19 expressions per call
export function participantsUnchanged() {
  return request.resource.data.host == resource.data.host
      && request.resource.data.guest == resource.data.guest;
}
`,
  "storage/metadata": `// @pyric-services firebase.storage
// @pyric-evidence storage-rules#132
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Storage custom-metadata policies. Custom metadata is a flat string map.

// cost 7 to 7 expressions per call
export function hasRequiredMetadata(keys) {
  return request.resource.metadata.keys().hasAll(keys);
}

// cost 28 to 28 expressions per call
export function metadataString(key, min, max) {
  return request.resource.metadata[key] is string
    && request.resource.metadata[key].size() >= min
    && request.resource.metadata[key].size() <= max;
}

// cost 6 to 16 expressions per call
export function incomingMetadataOwner(key) {
  return request.auth != null
    && request.resource.metadata[key] == request.auth.uid;
}

// cost 6 to 15 expressions per call
export function existingMetadataOwner(key) {
  return request.auth != null
    && resource.metadata[key] == request.auth.uid;
}
`,
  "storage/objects": `// @pyric-services firebase.storage
// @pyric-evidence storage-rules#132
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Storage operation identity. Use request.method rather than null checks:
// production treats missing resource/request.resource bindings as errors.

// cost 5 to 5 expressions per call
export function isCreate() {
  return request.method == 'create';
}

// cost 5 to 5 expressions per call
export function isUpdate() {
  return request.method == 'update';
}

// cost 5 to 5 expressions per call
export function isDelete() {
  return request.method == 'delete';
}
`,
  "storage/time": `// @pyric-services firebase.storage
// @pyric-evidence storage-rules#132
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Freshness checks over server-owned Storage object timestamps. Boundaries are
// strict: equality with the deadline is not "within" the window.

// cost 10 to 10 expressions per call
export function createdWithin(seconds) {
  return request.time < resource.timeCreated + duration.value(seconds, 's');
}

// cost 10 to 10 expressions per call
export function updatedWithin(seconds) {
  return request.time < resource.updated + duration.value(seconds, 's');
}
`,
  "storage/uploads": `// @pyric-services firebase.storage
// @pyric-evidence storage-rules#132
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Storage upload request primitives. These inspect declared object metadata;
// MIME helpers do not inspect or authenticate the uploaded bytes.

// cost 6 to 6 expressions per call
export function sizeAtMost(maxBytes) {
  return request.resource.size <= maxBytes;
}

// cost 7 to 13 expressions per call
export function sizeBetween(minBytes, maxBytes) {
  return request.resource.size >= minBytes
    && request.resource.size <= maxBytes;
}

// cost 6 to 6 expressions per call
export function contentTypeMatches(pattern) {
  return request.resource.contentType.matches(pattern);
}

// cost 6 to 6 expressions per call
export function contentTypeIsOneOf(types) {
  return request.resource.contentType in types;
}
`,
  "timing": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Timing module for cooldown / rate-limit enforcement.
//
// Rules CAN rate-limit (contrary to a common assumption — jrpg
// FINDINGS F-004): compare request.time against a stored server
// timestamp. Pair with lifecycle's isServerTimestamp on the SAME
// write so the stored timestamp cannot be forged by the client:
//
//   import { cooldownElapsed } from 'timing';
//   import { isServerTimestamp } from 'lifecycle';
//
//   // At most one move every 2 seconds:
//   allow update: if cooldownElapsed('lastMoveAt', 2)
//     && isServerTimestamp('lastMoveAt');

// The stored timestamp is more than \`seconds\` old (strict). Update
// rules only — needs \`resource\`. The field must be a Timestamp; a
// missing field errors, which denies (fail-closed).
// cost 12 to 12 expressions per call
export function cooldownElapsed(field, seconds) {
  return request.time > resource.data[field] + duration.value(seconds, 's');
}
`,
  "transitions": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Transitions module for state machine enforcement.
//
// Validates that a field transitions from one known value to another.
// Use to enforce valid status flows (e.g., open -> in_progress -> completed).
//
// Usage:
//   import { validTransition, statusIs, newStatusIs } from 'transitions';
//
//   // Only allow open -> in_progress
//   allow update: if validTransition('status', 'open', 'in_progress');
//
//   // Allow update only when currently active
//   allow update: if statusIs('status', 'active');
//
//   // Compound: multiple valid transitions via OR
//   allow update: if validTransition('status', 'open', 'in_progress')
//     || validTransition('status', 'in_progress', 'completed')
//     || validTransition('status', 'completed', 'archived');

// Check that a field transitions from one value to another.
// cost 8 to 16 expressions per call
export function validTransition(field, from, to) {
  return resource.data[field] == from
    && request.resource.data[field] == to;
}

// Check the current (existing) value of a field.
// cost 7 to 7 expressions per call
export function statusIs(field, value) {
  return resource.data[field] == value;
}

// Check the incoming (new) value of a field.
// cost 8 to 8 expressions per call
export function newStatusIs(field, value) {
  return request.resource.data[field] == value;
}
`,
  "turns": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Turn enforcement for games/sessions: two-seat games with named seats, and
// games of any size with a seat list.
//
// Two-seat convention: documents must have these fields:
//   host: string (UID)
//   guest: string (UID)
//   currentTurn: 'host' | 'guest'
//
// Seat-list convention: documents must have these fields:
//   players: list of UIDs, one per seat, in turn order
//   turn: int, the index in \`players\` of the seat whose turn it is
//
// Yacht and Uno store these two fields under these names. isSeatTurn takes
// the list and the index as arguments, so a document that names them
// differently can still use it; turnAdvanced reads \`players\` and \`turn\`.
//
// Usage:
//   import { isMyTurn, turnFlipped, isSeatTurn, turnAdvanced } from 'turns';
//
//   // Two seats:
//   allow update: if isMyTurn() && turnFlipped();
//
//   // A seat list:
//   allow update: if isSeatTurn(resource.data.players, resource.data.turn)
//     && turnAdvanced(resource.data.players.size());

// Is the caller the participant whose turn it is?
// cost 16 to 23 expressions per call
export function isMyTurn() {
  return (resource.data.currentTurn == 'host'
            && request.auth.uid == resource.data.host)
      || (resource.data.currentTurn == 'guest'
            && request.auth.uid == resource.data.guest);
}

// Did the turn alternate?
// cost 15 to 22 expressions per call
export function turnFlipped() {
  return (resource.data.currentTurn == 'host'
            && request.resource.data.currentTurn == 'guest')
      || (resource.data.currentTurn == 'guest'
            && request.resource.data.currentTurn == 'host');
}

// Is the caller's uid \`seats[turnIndex]\`? \`seats\` is a list of UIDs and
// \`turnIndex\` an int. A signed-out request is false. An index past the last
// seat, or below 0, is an error, and the request is denied.
// cost 6 to 14 expressions per call
export function isSeatTurn(seats, turnIndex) {
  return request.auth != null && seats[turnIndex] == request.auth.uid;
}

// Did the turn move to the next seat? The new \`turn\` equals the old \`turn\`
// plus one, modulo \`seatCount\`, so the last seat wraps to seat 0. \`%\` on two
// ints is the remainder, as in production. The \`players\` list is unchanged.
// cost 14 to 23 expressions per call
export function turnAdvanced(seatCount) {
  return request.resource.data.turn == (resource.data.turn + 1) % seatCount
    && request.resource.data.players == resource.data.players;
}
`,
  "validation": `// @pyric-services cloud.firestore
// Costs are production expressions per call, not counting arguments. Calls
// are not memoized: every call pays its full cost again, and a let inside a
// function is paid on every call.
//
// Validation module for document field shape and value checks.
//
// Usage:
//   import { hasRequired, hasOnly, validString, isOneOf } from 'validation';
//
//   allow create: if hasRequired(['title', 'status'])
//     && validString('title', 1, 100)
//     && isOneOf('status', ['draft', 'published']);

// cost 7 to 7 expressions per call
export function hasRequired(fields) {
  return request.resource.data.keys().hasAll(fields);
}

// cost 7 to 7 expressions per call
export function hasOnly(fields) {
  return request.resource.data.keys().hasOnly(fields);
}

// Incoming field is a string with size in [min, max] (inclusive).
// Uses dynamic access, so a MISSING field reads as null (not an
// error) and fails the \`is string\` check — safe on optional fields.
// cost 10 to 28 expressions per call
export function validString(field, min, max) {
  return request.resource.data[field] is string
    && request.resource.data[field].size() >= min
    && request.resource.data[field].size() <= max;
}

// Enum check: the incoming field value is one of the allowed values.
// (\`in\` on a list — NOT \`.includes()\`, which does not exist in rules.)
// cost 8 to 8 expressions per call
export function isOneOf(field, values) {
  return request.resource.data[field] in values;
}
`,
};
