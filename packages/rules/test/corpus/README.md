# Firestore Rules Test Corpus

Test files for the Firestore rules parser, validator, and assembler.

## Structure

```
corpus/
├── valid/          Files the parser MUST accept
├── invalid/        Files the parser MUST reject
└── edge-cases/     Valid files testing boundary conditions
```

## Valid (20 files)

| File | Tests |
|---|---|
| 001-minimal | Empty rules (just boilerplate) |
| 002-allow-all | Recursive wildcard, allow all |
| 003-deny-all | Recursive wildcard, deny all |
| 004-all-operation-types | read, write, get, list, create, update, delete |
| 005-combined-operations | `allow read, write: if ...` |
| 006-auth-checks | `request.auth`, uid, token claims |
| 007-data-validation | `request.resource.data`, `resource.data`, comparisons |
| 008-functions | Definitions, parameters, calling other functions, `get()` |
| 009-nested-match | Subcollections, 3 levels deep |
| 010-cross-document-reads | `get()`, `exists()` with path interpolation |
| 011-type-checking | `is` operator: string, int, float, bool, timestamp, list, map |
| 012-list-map-operations | `keys()`, `hasAll()`, `hasOnly()`, `hasAny()`, `size()`, `in` |
| 013-string-methods | `matches()`, `size()` on strings |
| 014-arithmetic-comparison | `>=`, `<=`, `+`, arithmetic on values |
| 015-ternary-and-negation | `? :` operator, `!` negation |
| 016-recursive-wildcard | `{var=**}`, override pattern |
| 017-comments | Single-line, multi-line, inline |
| 018-path-interpolation | `$(database)`, `$(request.auth.uid)` in paths |
| 019-bracket-access | `data['field']`, `data[variable]`, `in` operator |
| 020-complex-real-world | Full blog app with functions, validation, cross-doc |
| 021-production-blockingfun | Real deployed rules from the blockingfun project |

## Invalid (8 files)

| File | Tests |
|---|---|
| 001-missing-version | No `rules_version` declaration |
| 002-missing-semicolon | Allow statement without trailing `;` |
| 003-unclosed-match | Missing closing brace |
| 004-invalid-operation | `allow readwrite` (not a valid operation) |
| 005-expression-syntax-error | Incomplete expression (`!= ;`) |
| 006-function-no-return | Function body without `return` |
| 007-unclosed-paren | Unbalanced parentheses |
| 008-wrong-service | `service firebase.storage` (not Firestore) |

## Edge Cases (8 files)

| File | Tests |
|---|---|
| 001-multiple-match-same-path | Two match blocks for same path (rules OR) |
| 002-deeply-nested-expressions | Complex boolean nesting |
| 003-scoped-functions | Functions in different match blocks |
| 004-string-escapes | Regex patterns with backslash escapes |
| 005-string-concatenation | `+` operator on strings (composite keys) |
| 006-null-checks | Optional fields, null comparisons |
| 007-map-diff | `diff()`, `affectedKeys()` methods |
| 008-timestamp-operations | `request.time`, `duration.value()` |

## How to use

The parser test should:
1. Load every file in `valid/` and verify it parses without errors
2. Load every file in `invalid/` and verify it FAILS to parse
3. Load every file in `edge-cases/` and verify it parses (valid syntax)
4. For valid files: round-trip (parse → assemble → compare)
5. For production file: verify parsed structure matches expected collections

## Adding new corpus files

When a new language feature is discovered or a parser bug is found:
1. Create a minimal `.rules` file that exercises the feature
2. Add it to the appropriate directory
3. Add it to this README
4. The grammar must accept/reject it correctly
