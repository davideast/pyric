# Importing Arcade chess rules

Arcade's stock contract is pinned at `66e14d4f4b0aeab22c05db8d748704dde053d2e5`. Four complete linked rulesets sit in [artifacts](artifacts/manifest.json). Each includes the other Arcade games and the original rematch paths. The stock rebuild must match the archived byte sequence before the build can emit a candidate.

| Profile | Match move accepted by the client SDK when |
|---|---|
| Stock | The existing chess write protocol accepts the update. This includes turn, seat, increment, changed squares, previous state and the shape of the claimed result. |
| Compatibility | The same stock predicates hold. The packed Pyric compiler emits two replacements, `castleMetadata` and `priorPosition`. Lifecycle, identity and changed-field rules come from Arcade. |
| Stronger | The stock move contract and the board predicates below hold. The game engine still judges king safety and the truth of a claimed terminal result. |
| Referee | Clients can create, join, cancel, resign and rematch. The chess move grant is absent. A separately authenticated admission service must evaluate the legal move and commit the calculated successor against the observed database version. |

To import the compatibility profile into the pinned Arcade checkout, place `artifacts/compatibility-module.rules` at `games/chess/chess.rules` and `artifacts/compatibility-helpers.rules` beside it as `chess-helpers.rules`. The stronger pair uses the same two destination names. Both expose the existing five public game functions so the root import works unchanged. The `.rules` files ending in `-helpers` use Arcade's build-time `2+modules` syntax. The complete profile files contain linked Firebase Rules v2.

## What the stronger profile derives

| Requirement | Inputs and ownership |
|---|---|
| Piece geometry | Coordinates from the two named squares, signed rank and file distances, color, destination occupant and prior en passant square. The compiled `pieceShape` covers all six piece types. Pawn pushes include the starting-rank and empty-target checks. |
| Sliding path and two-square pawn push | Actual occupants of up to six intermediate squares. Standard Rules composes the emitted `rayEmpty` helper with a bounded, unrolled path along the move. |
| Castling and en passant board changes | Prior castling rights, rook presence, clearance on both sides, required sorted extra squares, rook arrival, captured pawn and resulting empty squares. The authoritative policy also checks attacks on the king's start, transit and destination. |
| Successor rights and promotion | The rule derives the four surviving castling flags and the only valid next en passant square. It requires a promotion at the final rank and uses Arcade's validated piece choices and destination piece. |
| Stored map completeness | The new board retains all prior keys. Stock already constrains added keys and squares allowed to change. |
| Self-check and terminal result | The standalone policy searches for attacks and legal replies. The stronger database profile enforces the shape of the claimed result. The referee profile routes all moves through admission so standalone checks run before commit. |

Seven additional pure helpers pass through the compiler for the stronger build. Two standard Rules functions in [source](source) compose those helpers and bind the actual request data. The compiler does not consume the whole chess engine as a single Firestore input. The generated modules, retained wrappers and source expressions are individually identifiable in [the builder](build.mjs).

## Rebuild and check

The following run installs the pinned experimental compiler, separately installs the frozen reference evaluator, and unpacks the pinned Arcade resolver. It uses only local tarballs. The compiler package digest is verified inside the script, alongside all four vendored dependency digests.

```sh
trial=experiments/policy-oracle/trials/chess/bundle
compiler="$HOME/.local/state/pyric/oracle/2026-11-25-89219c79/packages/yacht-3a79e94878d551a292757774f3e39cd2f3d57b15ffec93200807922ae3120fa6.tgz"
python3 "$trial/reproduce.py" --compiler "$compiler" --arcade "$HOME/repos/davideast/arcade"
```

The run reproduces all nine archived artifact files byte for byte and all 600 local decisions across 150 public cases. Each case evaluates the complete linked ruleset in all four profiles. The highest locally measured expression count was 965 for the stronger profile, on Black's rook capture from a8 to a1. The first layout exceeded the evaluator's 1,000-expression limit on legal castling. Hoisting the path-coordinate lists, removing redundant metadata checks and sharing decoded rights reduced the measured cost. These are simulator counts for the named inputs. [Exact per-profile results and maxima](local-results.json)

The live controller uses [normal game fixtures](special-cases.mjs) in addition to its lifecycle and replay cases. Stock and compatibility receive legal positive special-move controls. Stronger adds the corresponding expected refusals for hardened requirements. Standalone residuals are exercised by the independent oracle and by authoritative admission. Only a completed hosted receipt and verified readbacks qualify a hosted verdict.
