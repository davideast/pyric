# Blind authoring trial

Two fresh authors received the same path-clearance brief, two public test cases and a 15-minute cap. Each syntax card supplied one example and its corresponding public compiler entry point. Each author saved a first attempt before running the public tests, then locked a final source. Hidden scoring began after both locks. [Common brief](BRIEF.md) · [Public tests](public.mjs) · [Current syntax card](current/SYNTAX.md) · [Loop syntax card](loop/SYNTAX.md)

| Syntax | First submission | Locked submission |
|---|---:|---:|
| Existing `bounded.any` | 256/256 | 256/256, identical source |
| Proposed `for...of` | Parse error, 256 cases unevaluated | 256/256, second submission |

The first loop solution tried two conditional returns in the loop body. The parser stopped at the second `if` on line 9, column 5 with `Expected "}"`. The author combined the conditions into a single guard before lock. The complete diagnostic and each revision's digest appear in the scores. Both locked submissions produced zero false allows and zero false refusals. This single task measures one author per syntax; it supplies no estimate of time savings or relative author success rates. [First loop submission](loop/first.policy) · [Locked loop submission](loop/locked.policy) · [Score by revision and compiler](scores.json)

The verifier compared each original package tarball with its npm integrity value and its installed files. The retained observations were reproduced from fresh offline installs. The subsequent reviewed compiler yielded identical scores and diagnostic text on every saved revision. The sealed positions remain in the verifier's private archive. The `current`, `loop` and `reviewed` entries in the score identify their tarballs by SHA-256. The original loop tarball is retained under its digest with the private corpus.

Given the verifier-held inputs and pinned tarballs, this command reproduces the saved score:

```sh
python3 replay.py "$corpus" "$current_pack" "$loop_author_pack" "$reviewed_pack" | cmp - scores.json
```
