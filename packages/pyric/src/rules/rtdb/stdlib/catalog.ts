/**
 * The catalog of the RTDB rules standard library, as the `rules_stdlib_list`
 * and `rules_stdlib_get` tools return it for `service: 'database'`.
 *
 * Each entry's `output` is what its example compiles to, computed here from
 * the builder itself, so the catalog cannot drift from the code. A test keeps
 * every exported builder and its catalog entry in one-to-one agreement.
 */
import type { Expr, PathDef } from '../constraints/types.js';
import { rtdbStdlib } from './index.js';

export interface RtdbStdlibEntry {
  /** The export name inside the module namespace. */
  name: string;
  /** TypeScript signature. */
  signature: string;
  /** Where the result goes: the node and the rule kind. */
  placement: string;
  description: string;
  /** A call as you would write it. */
  example: string;
  /** What the example compiles to: rule expression text, or a path definition fragment. */
  output: Expr | PathDef | readonly string[];
  /** Characters in `output` when it is one expression. */
  length?: number;
  notes?: string;
}

export interface RtdbStdlibModule {
  /** Module key and the namespace name on `rtdbStdlib`. */
  key: keyof typeof rtdbStdlib;
  kind: 'rtdb-builders';
  services: readonly ['database'];
  description: string;
  purpose: string;
  whenToUse: string;
  /** The data layout the module's builders read, when it assumes one. */
  convention?: string;
  entries: RtdbStdlibEntry[];
  examples?: string[];
  relatedKeys?: string[];
}

type EntryInput = Omit<RtdbStdlibEntry, 'output' | 'length'> & { build: () => Expr | PathDef | readonly string[] };

function entry({ build, ...rest }: EntryInput): RtdbStdlibEntry {
  const output = build();
  return typeof output === 'string' ? { ...rest, output, length: output.length } : { ...rest, output };
}

const { validation, lifecycle, lobby, turns, results, counters, presence, timing, collections } = rtdbStdlib;

const MATCH_CONVENTION =
  "A match node such as /matches/$matchId with leaf children host (creator uid), guest ('' while open, then the joiner's uid), status ('waiting', 'playing', then 'won' | 'draw' | 'resigned'), currentTurn ('host' | 'guest'), winner ('host' | 'guest' | ''), moveCount (number). The same convention as the Firestore lobby, turns and results modules.";

const MODULES: Array<Omit<RtdbStdlibModule, 'kind' | 'services'>> = [
  {
    key: 'validation',
    description: 'Type and value of a written node, required fields, and the closed shape of a record.',
    purpose:
      'Field checks read newData of the node they are placed on: put them in a field node\'s .validate. requiredFields and shape go on the record. shape types every field and refuses any other child through a $other wildcard whose .validate is false.',
    whenToUse: 'Every node a client writes: give the record a shape and each field a type and range.',
    entries: [
      entry({ name: 'isString', signature: 'isString(): Expr', placement: 'field node .validate', description: 'The written value is a string.', example: 'validation.isString()', build: () => validation.isString() }),
      entry({ name: 'isNumber', signature: 'isNumber(): Expr', placement: 'field node .validate', description: 'The written value is a number.', example: 'validation.isNumber()', build: () => validation.isNumber() }),
      entry({ name: 'isBoolean', signature: 'isBoolean(): Expr', placement: 'field node .validate', description: 'The written value is a boolean.', example: 'validation.isBoolean()', build: () => validation.isBoolean() }),
      entry({ name: 'stringLength', signature: 'stringLength(min: number, max: number): Expr', placement: 'field node .validate', description: 'A string of min to max characters.', example: 'validation.stringLength(1, 20)', build: () => validation.stringLength(1, 20) }),
      entry({ name: 'numberBetween', signature: 'numberBetween(min: number, max: number): Expr', placement: 'field node .validate', description: 'A number from min to max, inclusive.', example: 'validation.numberBetween(0, 100)', build: () => validation.numberBetween(0, 100) }),
      entry({
        name: 'oneOf', signature: 'oneOf(...values: Array<string | number | boolean | null>): Expr', placement: 'field node .validate',
        description: 'The written value equals one of the values.', example: "validation.oneOf('red', 'blue')", build: () => validation.oneOf('red', 'blue'),
        notes: "== does not convert types in production, so oneOf(1) refuses the string '1'.",
      }),
      entry({
        name: 'matches', signature: 'matches(pattern: string): Expr', placement: 'field node .validate',
        description: 'A string that matches the regular expression, written without slashes.', example: "validation.matches('^[a-z0-9_]+$')", build: () => validation.matches('^[a-z0-9_]+$'),
        notes: 'Anchor with ^ and $ to match the whole string. Escape / as \\/.',
      }),
      entry({ name: 'requiredFields', signature: 'requiredFields(...fields: string[]): Expr', placement: 'record node .validate', description: 'The record has every listed child.', example: "validation.requiredFields('name', 'score')", build: () => validation.requiredFields('name', 'score') }),
      entry({
        name: 'shape', signature: 'shape(spec: Record<string, FieldRule>, options?: { required?: string[]; open?: boolean }): { validate?: Expr; children: Record<string, PathDef> }',
        placement: 'record node: spread into its path definition',
        description: "Requires the required fields (default: all), gives each field its rule ('string', 'number', 'boolean', an expression, or a path definition), and refuses any other child.",
        example: "validation.shape({ name: validation.stringLength(1, 20), score: 'number' })",
        build: () => validation.shape({ name: validation.stringLength(1, 20), score: 'number' }) as PathDef,
        notes: 'To add a record check, write validate: all(result.validate, check). .validate does not run on a delete.',
      }),
    ],
    examples: [
      "'/players/$uid': { write: pathOwnerOnly('$uid'), ...validation.shape({ name: validation.stringLength(1, 12), level: validation.numberBetween(1, 10) }) }",
    ],
    relatedKeys: ['lifecycle', 'counters'],
  },
  {
    key: 'lifecycle',
    description: 'Which fields a write may change, ownership through a uid field, write-once and no-delete records.',
    purpose:
      'Builders read data and newData of the record node. On an update of some children, newData at the record is the merged record, so one rule covers a set and an update. RTDB rules cannot list children, so the changed-field checks take the record\'s leaf field list; pair them with validation.shape so no unlisted field can be written.',
    whenToUse: 'An update rule that must leave some fields alone, a record owned by the uid in one of its fields, or a node that is written once or never deleted.',
    entries: [
      entry({ name: 'unchanged', signature: 'unchanged(...fields: string[]): Expr', placement: 'record node .write or .validate', description: 'Each listed field has the same value before and after.', example: "lifecycle.unchanged('createdAt')", build: () => lifecycle.unchanged('createdAt'), notes: 'Leaf fields only: == does not compare objects.' }),
      entry({ name: 'immutableFields', signature: 'immutableFields(...fields: string[]): Expr', placement: 'record node .validate (a delete passes) or .write (a delete is refused)', description: 'The fields keep the value they were created with; a create passes.', example: "lifecycle.immutableFields('owner', 'createdAt')", build: () => lifecycle.immutableFields('owner', 'createdAt') }),
      entry({ name: 'onlyFieldsChanged', signature: 'onlyFieldsChanged(changed: string[], fields: string[]): Expr', placement: 'record node .write', description: 'Of the record\'s fields, only the changed ones may differ; they may also stay the same.', example: "lifecycle.onlyFieldsChanged(['name', 'bio'], ['name', 'bio', 'role'])", build: () => lifecycle.onlyFieldsChanged(['name', 'bio'], ['name', 'bio', 'role']), notes: 'A create changes every field from null; combine with isNew() for creates.' }),
      entry({ name: 'exactlyChanged', signature: 'exactlyChanged(changed: string[], fields: string[]): Expr', placement: 'record node .write', description: 'Every changed field differs and every other field is the same.', example: "lifecycle.exactlyChanged(['body', 'rev'], ['body', 'rev', 'title'])", build: () => lifecycle.exactlyChanged(['body', 'rev'], ['body', 'rev', 'title']) }),
      entry({ name: 'createOnly', signature: 'createOnly(): Expr', placement: 'node .write', description: 'The write creates the node; an overwrite or a delete is refused.', example: 'lifecycle.createOnly()', build: () => lifecycle.createOnly() }),
      entry({ name: 'noDelete', signature: 'noDelete(): Expr', placement: 'node .write', description: 'The write leaves a value at the node.', example: 'lifecycle.noDelete()', build: () => lifecycle.noDelete() }),
      entry({ name: 'ownedBy', signature: 'ownedBy(field: string): Expr', placement: 'record node .write', description: 'A create names the writer in field; only that owner updates, without changing the owner, or deletes.', example: "lifecycle.ownedBy('owner')", build: () => lifecycle.ownedBy('owner'), notes: 'For a record keyed by uid, such as /users/$uid, use pathOwnerOnly(\'$uid\').' }),
    ],
    relatedKeys: ['validation', 'lobby'],
  },
  {
    key: 'lobby',
    description: 'Create, join, cancel and rematch a two-player match.',
    purpose: 'The match node\'s .write. Builders read the stored match (data) and the match after the write (newData), so a join written as an update of guest and status reaches them.',
    whenToUse: 'A two-player game or session where one user opens a match and another takes the open seat.',
    convention: MATCH_CONVENTION,
    entries: [
      entry({ name: 'MATCH_FIELDS', signature: 'MATCH_FIELDS: readonly string[]', placement: 'argument to the changed-field checks', description: 'The leaf fields of a match in the convention.', example: 'lobby.MATCH_FIELDS', build: () => lobby.MATCH_FIELDS }),
      entry({ name: 'validCreate', signature: 'validCreate(): Expr', placement: 'match node .write', description: "The write creates the match with the writer as host, guest '' and status 'waiting'.", example: 'lobby.validCreate()', build: () => lobby.validCreate() }),
      entry({ name: 'validJoin', signature: 'validJoin(fields?: readonly string[]): Expr', placement: 'match node .write', description: "The writer takes the open seat of a waiting match hosted by someone else; status becomes 'playing' and every other field keeps its value.", example: 'lobby.validJoin()', build: () => lobby.validJoin() }),
      entry({ name: 'canCancel', signature: 'canCancel(): Expr', placement: 'match node .write', description: 'The host deletes the match while it waits for a guest.', example: 'lobby.canCancel()', build: () => lobby.canCancel() }),
      entry({
        name: 'validRematch', signature: 'validRematch(): Expr', placement: 'match node .write',
        description: "A create as validCreate whose rematchOf child names a finished sibling match ('won', 'draw' or 'resigned') in which the writer held a seat.",
        example: 'lobby.validRematch()', build: () => lobby.validRematch(),
        notes: "Reads the previous match through data.parent(), not root. A plain create should also refuse rematchOf: all(lobby.validCreate(), not(newDataExists('rematchOf'))).",
      }),
    ],
    examples: [
      "write: any(all(lobby.validCreate(), not(newDataExists('rematchOf'))), lobby.validRematch(), lobby.validJoin(), lobby.canCancel())",
    ],
    relatedKeys: ['turns', 'results', 'lifecycle'],
  },
  {
    key: 'turns',
    description: 'The seat on turn and the next turn, for two named seats or a seat list.',
    purpose: 'The match node\'s .write. Turn checks read the stored match, never the written one, so a player cannot hand themself the turn. RTDB rules have no loops, so the seat-list builders take the seat count at build time and write one comparison per seat.',
    whenToUse: 'A turn-based game: gate each move on the seat on turn and check that the turn passes on.',
    convention: `${MATCH_CONVENTION} Seat lists: players holds one uid per seat under keys '0' to 'n - 1', and turn is the number of the seat on turn.`,
    entries: [
      entry({ name: 'isMyTurn', signature: 'isMyTurn(): Expr', placement: 'match node .write', description: 'The writer holds the seat the stored currentTurn names.', example: 'turns.isMyTurn()', build: () => turns.isMyTurn() }),
      entry({ name: 'turnFlipped', signature: 'turnFlipped(): Expr', placement: 'match node .write', description: 'currentTurn passes to the other seat.', example: 'turns.turnFlipped()', build: () => turns.turnFlipped() }),
      entry({ name: 'isSeatTurn', signature: 'isSeatTurn(seatCount: number): Expr', placement: 'match node .write', description: 'The writer\'s uid is in the seat the stored turn names.', example: 'turns.isSeatTurn(3)', build: () => turns.isSeatTurn(3) }),
      entry({ name: 'turnAdvanced', signature: 'turnAdvanced(seatCount: number): Expr', placement: 'match node .write', description: 'turn moves to the next seat, wrapping to 0, and every seat keeps its uid.', example: 'turns.turnAdvanced(3)', build: () => turns.turnAdvanced(3) }),
    ],
    examples: [
      "write: all(turns.isMyTurn(), turns.turnFlipped(), results.resultUnchanged(), lifecycle.onlyFieldsChanged(['currentTurn', 'moveCount'], lobby.MATCH_FIELDS))",
    ],
    relatedKeys: ['lobby', 'results', 'counters'],
  },
  {
    key: 'results',
    description: 'How a two-player match ends: resignation, win or draw, and that other writes keep the result.',
    purpose: 'The match node\'s .write. A resignation is status \'resigned\' with the other seat as winner, a win is \'won\' with a seat, a draw is \'draw\' with winner \'\'. Only status and winner change.',
    whenToUse: 'The resign button, a write that records how the match ended, and every other move.',
    convention: MATCH_CONVENTION,
    entries: [
      entry({ name: 'resignedBy', signature: 'resignedBy(fields?: readonly string[]): Expr', placement: 'match node .write', description: "A seated player resigns: status 'playing' to 'resigned', the other seat wins, only status and winner change.", example: 'results.resignedBy()', build: () => results.resignedBy() }),
      entry({
        name: 'finishedWithWinner', signature: "finishedWithWinner(winner: 'host' | 'guest' | '', reason: 'won' | 'draw', fields?: readonly string[]): Expr", placement: 'match node .write',
        description: "status 'playing' to reason, winner set, only status and winner change. Does not check the writer.",
        example: "results.finishedWithWinner('host', 'won')", build: () => results.finishedWithWinner('host', 'won'),
        notes: "Throws at build time for a 'won' without a seat or a 'draw' with one. Combine with turns.isMyTurn().",
      }),
      entry({ name: 'resultUnchanged', signature: 'resultUnchanged(): Expr', placement: 'match node .write', description: 'status and winner keep their values.', example: 'results.resultUnchanged()', build: () => results.resultUnchanged() }),
    ],
    relatedKeys: ['lobby', 'turns'],
  },
  {
    key: 'counters',
    description: 'Numbers that move by a known step, only improve, or advance one side of a score at a time.',
    purpose: 'incrementedBy, changedBy and improved go in the counter node\'s .validate; oneIncremented in the .validate of the node holding the counters. Each requires a stored value before adding to it, so no rule adds to null.',
    whenToUse: 'Likes, move counts, best scores, fastest times, and a two-sided score that changes one goal at a time.',
    entries: [
      entry({ name: 'incrementedBy', signature: 'incrementedBy(n: number, options?: { start?: number }): Expr', placement: 'counter node .validate', description: 'The written number is the stored one plus n; with start, a create writes start.', example: 'counters.incrementedBy(1, { start: 0 })', build: () => counters.incrementedBy(1, { start: 0 }), notes: '.validate runs on every node a write carries, so a set of the parent with the counter unchanged is refused. Write the counter on its own.' }),
      entry({ name: 'changedBy', signature: 'changedBy(min: number, max: number): Expr', placement: 'counter node .validate', description: 'The written number differs from the stored one by min to max.', example: 'counters.changedBy(-1, 1)', build: () => counters.changedBy(-1, 1) }),
      entry({ name: 'improved', signature: "improved(direction: 'up' | 'down'): Expr", placement: 'counter node .validate', description: 'Strictly greater (up) or smaller (down) than the stored number; the first value passes.', example: "counters.improved('up')", build: () => counters.improved('up') }),
      entry({ name: 'oneIncremented', signature: 'oneIncremented(fields: string[], n: number, options?: { start?: number }): Expr', placement: 'node holding the counters .validate', description: 'Exactly one child counter grows by n and the others keep their values; with start, a create writes every field as start.', example: "counters.oneIncremented(['host', 'guest'], 1, { start: 0 })", build: () => counters.oneIncremented(['host', 'guest'], 1, { start: 0 }) }),
    ],
    relatedKeys: ['validation', 'turns'],
  },
  {
    key: 'presence',
    description: 'Who is online: a per-user node the owner writes, cleared by an onDisconnect write.',
    purpose:
      'One node per user under a presence collection such as /status/$uid. record() is the path definition for { state, lastChanged } with lastChanged the server timestamp; flag() for a boolean. The server checks the rules for an onDisconnect write when the client registers it and again when it runs, so the offline value passes the same rules as the online one.',
    whenToUse: 'Showing who is connected, and letting a match react to a player who dropped.',
    convention: "/status/$uid holds { state: 'online' | 'offline', lastChanged: <server timestamp> }; /online/$uid holds true or false.",
    entries: [
      entry({ name: 'ownPresence', signature: "ownPresence(pathVar?: string): Expr", placement: 'presence node .write', description: 'The signed-in user writes the node keyed by their uid.', example: 'presence.ownPresence()', build: () => presence.ownPresence() }),
      entry({
        name: 'record', signature: 'record(pathVar?: string): PathDef', placement: 'the path definition of /status/$uid',
        description: "Owner-written { state: 'online' | 'offline', lastChanged: server timestamp } with no other child; signed-in users read it.",
        example: "'/status/$uid': presence.record()", build: () => presence.record(),
        notes: "Client: onDisconnect(ref).set({ state: 'offline', lastChanged: serverTimestamp() }) then set(ref, { state: 'online', lastChanged: serverTimestamp() }). onDisconnect(ref).remove() is a delete, which the owner's .write allows.",
      }),
      entry({ name: 'flag', signature: 'flag(pathVar?: string): PathDef', placement: 'the path definition of /online/$uid', description: 'Owner-written boolean presence.', example: "'/online/$uid': presence.flag()", build: () => presence.flag() }),
    ],
    relatedKeys: ['timing', 'results'],
  },
  {
    key: 'timing',
    description: 'Server timestamps, times not in the future, cooldowns and per-user rate limits.',
    purpose:
      'now is the server clock in milliseconds. A client writes serverTimestamp(), which the server replaces with now before it evaluates the rules. With no field a builder reads the node it is on; with a field, that child of the record.',
    whenToUse: 'A trusted creation time, a move cooldown, or a limit of one post per interval per user.',
    entries: [
      entry({ name: 'isServerTimestamp', signature: 'isServerTimestamp(field?: string): Expr', placement: 'field node .validate, or record node with field', description: 'The written value is the server timestamp.', example: 'timing.isServerTimestamp()', build: () => timing.isServerTimestamp() }),
      entry({ name: 'notInFuture', signature: 'notInFuture(field?: string): Expr', placement: 'field node .validate, or record node with field', description: 'A number no later than the server clock.', example: 'timing.notInFuture()', build: () => timing.notInFuture() }),
      entry({ name: 'cooldownElapsed', signature: 'cooldownElapsed(ms: number, field?: string): Expr', placement: 'record node .write with field', description: 'Nothing stored yet, or the stored time is more than ms before now.', example: "timing.cooldownElapsed(2000, 'lastMoveAt')", build: () => timing.cooldownElapsed(2000, 'lastMoveAt'), notes: "Pair with timing.isServerTimestamp('lastMoveAt') so the client cannot write an old time." }),
      entry({ name: 'throttled', signature: 'throttled(ms: number): Expr', placement: 'stamp node .validate, such as /lastPost/$uid', description: 'The stamp is set to the server time, and only once ms have passed since the stored one.', example: 'timing.throttled(60000)', build: () => timing.throttled(60000) }),
      entry({
        name: 'stampedInSameWrite', signature: 'stampedInSameWrite(levelsUp: number, segments: Array<string | { $: string }>): Expr', placement: 'rate-limited node .validate',
        description: 'The same write sets the stamp at segments, read levelsUp levels above, to the server time.',
        example: "timing.stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }])", build: () => timing.stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }]),
        notes: "Write the post and the stamp in one multi-path update: update(ref(db), { 'posts/p1': post, ['lastPost/' + uid]: serverTimestamp() }).",
      }),
    ],
    relatedKeys: ['presence', 'counters'],
  },
  {
    key: 'collections',
    description: 'Which keys a collection may hold, which bounds its size.',
    purpose:
      'RTDB rules cannot count children. A wildcard limited to the keys 0 to max - 1 (how a client stores an array) holds at most max children; keyIn limits it to a fixed list.',
    whenToUse: 'Seats, slots, a fixed set of flags, or any list with a maximum length.',
    entries: [
      entry({ name: 'keyIn', signature: 'keyIn(pathVar: string, keys: string[]): Expr', placement: 'wildcard node .validate', description: 'The wildcard key is one of keys.', example: "collections.keyIn('$flag', ['red', 'blue'])", build: () => collections.keyIn('$flag', ['red', 'blue']) }),
      entry({ name: 'slotKey', signature: 'slotKey(pathVar: string, max: number): Expr', placement: 'wildcard node .validate', description: "The wildcard key is '0' to max - 1.", example: "collections.slotKey('$slot', 4)", build: () => collections.slotKey('$slot', 4), notes: 'For free keys such as push IDs, keep a count next to the collection, bounded with validation.numberBetween and stepped with counters.changedBy(-1, 1), and write both in one multi-path update.' }),
    ],
    relatedKeys: ['validation', 'counters'],
  },
];

export const RTDB_STDLIB_MODULES: readonly RtdbStdlibModule[] = MODULES.map((module) => ({
  ...module,
  kind: 'rtdb-builders' as const,
  services: ['database'] as const,
}));

/** The import every RTDB standard library module is reached through. */
export const RTDB_STDLIB_IMPORT = "import { rtdbStdlib } from 'pyric/rules';";

/** The line that brings one module's namespace into scope. */
export function rtdbImportLineFor(module: RtdbStdlibModule): string {
  return `${RTDB_STDLIB_IMPORT} const { ${module.key} } = rtdbStdlib;`;
}

/** Case-insensitive lookup by key. */
export function findRtdbStdlibModule(key: string): RtdbStdlibModule | undefined {
  const k = key.toLowerCase();
  return RTDB_STDLIB_MODULES.find((module) => module.key.toLowerCase() === k);
}
