/**
 * "Game rules" skill — turn-based multiplayer games with Firestore
 * security rules as the anti-cheat layer.
 *
 * Condensed from `.agents/skills/firestore-game-rules/SKILL.md`
 * (+ its references and the RTDB twin's decomposition framing) — the
 * skill file is the SOURCE OF TRUTH for the knowledge; this is the
 * runtime copy the playground ships. Keep them in sync when the
 * patterns evolve. The 80K of generator assets in the skill dir stay
 * OUT of prompts entirely (P3 wires the code generator as a tool).
 */
import type { SkillDefinition } from './registry';
import { buildGameRulesHandler } from '~/lib/tools/skills/buildGameRules';

const BRIEF = [
  'The user is building a turn-based multiplayer game; Firestore rules are the anti-cheat layer. Every move is a doc update: the CLIENT claims the next state, the RULES verify it (correct player, legal move, real win) as boolean expressions — no loops.',
  'The rules stdlib ships game modules — `lobby`, `turns`, `state`, `geometry`, `counters`, `timing` (move cooldowns: rules CAN rate-limit), `lifecycle`, `transitions`. IMPORT them (`2+modules`), never copy bodies; `firestore_rules_stdlib_get({ key })` for signatures — invented functions fail compile.',
  'Hard constraints: (1) an undocumented expression-complexity ceiling denies over-complex rules SILENTLY — split `allow update` per state transition (move / win / draw); (2) `resource.data` = pre-write (WHO acts), `request.resource.data` = post-write (WHAT results) — swapping them is the #1 bug.',
  'Grid games (≤11x11): `build_game_rules` GENERATES win lines/gravity/integrity/split-allow — never hand-write them.',
  'READ `man game-rules` BEFORE designing data or rules.',
].join('\n');

const MAN_BODY = `GAME-RULES(7)                 skill: turn-based games on Firestore

MENTAL MODEL
  Every move is a document update. The client computes and CLAIMS the
  next state (board, turn flip, counters, win); the rules VERIFY the
  claim declaratively before persisting. Rules evaluate expressions —
  no loops, no variables, no recursion — so game logic must decompose
  into boolean constraints over two objects:
    resource.data          pre-write doc  — WHO may act (turn check),
                           what is already on the board (gravity)
    request.resource.data  post-write doc — WHAT the new state must
                           look like (legality, win claims)
  Swapping these is the most common bug: turn enforcement reads
  resource.data.currentTurn (who IS to move), never request.resource.

THE COMPLEXITY CEILING (the constraint that shapes everything)
  Firestore has an undocumented per-evaluation expression limit:
  ~130 expressions in one function works; ~200+ across the evaluation
  path FAILS SILENTLY as PERMISSION_DENIED. If valid moves are being
  denied and you cannot see why, you have hit the ceiling.
  The fix is the SPLIT-ALLOW pattern: multiple 'allow update' rules OR
  together, so give each state transition its own allow:
    allow update: if validMove(...) && status stays 'playing';
    allow update: if hasWonHost(...) && status == 'won' && winner set;
    allow update: if hasWonGuest(...) && ...;
    allow update: if moveCount == <max> && status == 'draw';
  Normal moves then never evaluate win detection and vice versa.
  (Tradeoff: a player CAN make a winning move while claiming
  status 'playing' — self-defeating, so acceptable; win CLAIMS are
  fully verified.)

DECOMPOSITION (answer in order — man page of the 7 questions)
  1. Board representation: FLAT map of named cells at the DOCUMENT TOP
     LEVEL (c0r0..c6r5 for 7x6; c0..c8 for tic-tac-toe). Rules cannot
     index by computed keys — 'c' + string(n) DOES NOT work; a stored
     field value as key DOES: data[request.resource.data.lastMove].
     Flat top-level cells are required for MapDiff (below).
  2. Players + turns: store host/guest UIDs (stdlib convention: 'host'
     = creator, 'guest' = joiner, currentTurn 'host'|'guest', status
     'waiting'|'playing'|'won'|'draw'). Enforce: only the current
     player's UID writes, and the turn marker flips every move
     (stdlib: turns.isMyTurn, turns.turnFlipped).
  3. Move validity — fork by game type:
     PLACEMENT games (tic-tac-toe, connect four, gomoku): cell was
       empty, now has the mover's mark. Client stores the cell name in
       lastMove; rules check resource.data[lastMove] == '' and
       request.resource.data[lastMove] == mark (2 expressions).
       Connect four adds gravity: per column, claimed row is the
       lowest empty (static enumeration over resource.data).
     MOVEMENT games (checkers, chess): geometry must be validated.
       Small move tables (<50 pairs): static OR branches. Multiple
       piece types / big boards: the CONFIG-DOCUMENT pattern — valid
       (from,to) pairs live in a Firestore doc (e.g. gameConfig/chess);
       rules read it ONCE per request with get() and validate via
       dynamic nesting config().moves[piece][from][to] (~3 exprs for
       ALL piece types). Sliding pieces add path-blocking: config
       stores between-cells; rules short-circuit-check each is empty.
       The config doc must exist BEFORE moves are attempted (seed it
       as admin, write-once, lock with allow write: if false).
       Checkmate detection is infeasible — use king-capture variant.
  4. Win detection:
     Placement: enumerate win lines as static conjunctions, one
       function PER PLAYER with hardcoded marks (8 lines for TTT, 69
       for connect four). Split directionally (horizontal / vertical /
       2 diagonals) when a single function nears the ceiling.
     Movement w/ capture: piece counters — win = opponent count == 0
       (one expression). Never re-scan the board.
  5. Terminal states: playing -> won | draw, enforced as transitions
     (stdlib: state, transitions). No writes after the game ends.
  6. Metadata: moveCount (must increment by exactly 1 — stdlib
     state.moveIncremented), lastMove, winner, status; player UIDs
     immutable mid-game (state.participantsUnchanged).
  7. Integrity: request.resource.data.diff(resource.data)
     .affectedKeys().hasOnly(['lastMove','currentTurn','moveCount',
     request.resource.data.lastMove]) — ONE expression proves only the
     expected fields changed (works with flat top-level cells; nested
     board.diff() is unreliable — do not use).

STDLIB (never invent — verify with the tools)
  firestore_rules_stdlib_list once, then _get({key}) per module used:
  lobby (validCreate/validJoin/canCancel), turns, state, membership,
  lifecycle, transitions, geometry, auth, validation, counters
  (incrementedBy/changedBy/boundedNumber), timing (cooldownElapsed —
  anti-speed-hack; pair with isServerTimestamp), content, spaces
  (parent-doc membership gates children — parties/rooms), joining
  (self-service join/leave a members map, no escalation), atomic
  (batch-write integrity via getAfter — counters, single-use invites).
  IMPORT these (rules_version = '2+modules'), never copy bodies —
  write_file inlines imports on save. Shape: man workflow.

WORKFLOW
  1. Model the doc (flat cells + host/guest/currentTurn/status/
     moveCount/lastMove) and say WHY.
  2. Rules that are repetitive (win lines, gravity) are GENERATED, not
     hand-written — hand-writing 69 win lines is an error factory.
     GRID GAMES: call build_game_rules (presets tic-tac-toe /
     connect-four / gomoku, or custom cols/rows/winLength/hasGravity,
     max 11x11). It returns the full ruleset + the exact game-doc
     shape (docShape) — review, then write the rules yourself and
     create docs matching docShape.
  3. Movement games: seed the config doc first (admin seed tool),
     locked write-once.
  4. Write firestore.rules (stdlib imports where they fit), lint, and
     deploy by writing the file.
  5. Seed a demo game doc as admin.
  6. Build the App UI: real sign-in, board renders from onSnapshot,
     moves are single atomic updates claiming the full next state.
  7. TEST BY VIOLATING: out-of-turn move, occupied cell, fake win
     claim, move after game over — each must be DENIED; legal moves
     ALLOW. Use workspace tests (man test) — categories: creation,
     turn enforcement, physical validity, win claims, false claims,
     terminal state.

ANTI-PATTERNS (each has burned a real build)
  - Computed/concatenated map keys ('c'+string(n)) — always denied.
  - Combined validMove + win check in ONE allow — ceiling; split.
  - Negated win checks (!hasWon()) on every move — ceiling.
  - Parameterized shared win function — use per-player generated fns.
  - Authorization read from request.resource.data — attacker-owned;
    authorize from resource.data.
  - Nested 'board' map + board.diff() — unreliable; flat + top-level
    diff only.
  - Hand-written win-line enumerations — generate them.
  - In-app seed/admin/identity-switcher UI — host surfaces own those;
    the app renders the END USER's game only.`;

export const firestoreGameRulesSkill: SkillDefinition = {
  id: 'game-rules',
  label: 'Game rules',
  icon: 'stadia_controller',
  description:
    'Turn-based multiplayer games with Firestore rules as the anti-cheat layer: decomposition workflow, stdlib game modules, complexity-ceiling patterns.',
  brief: BRIEF,
  manTopic: 'game-rules',
  manSummary: 'turn-based game rules: decomposition, split-allow, stdlib game modules',
  manBody: MAN_BODY,
  tools: () => [buildGameRulesHandler],
  // The GAME prompt shape — single source: the enhancer uses this both
  // as the always-on gate ("if the idea is a game…") and, when this
  // skill is ACTIVE, as the primary shape for every idea.
  enhancerShape: [
    '  - The game and its board/pieces (e.g. tic-tac-toe on a 3x3 grid).',
    '  - Players and turn order (e.g. two signed-in players alternate turns).',
    '  - The win/end condition.',
    '  - The anti-cheat boundary security rules must enforce: only the current player may move, moves must be legal, wins must be real.',
    '  - Verifiable by attempting an illegal move (out of turn, occupied cell, fake win) and seeing it rejected.',
  ].join('\n'),
};
