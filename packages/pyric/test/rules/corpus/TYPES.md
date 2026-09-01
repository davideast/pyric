# Firestore Rules Type System Reference

Compiled from Firebase documentation, production rules, and corpus testing.
This is the grammar's target — every type, method, property, and operator
the parser must handle.

Status: Working reference. Gaps marked with `[VERIFY]`.

## Primitive Types

### `bool`
- Literals: `true`, `false`
- Operators: `&&`, `||`, `!`
- No methods

### `int`
- Literals: `0`, `42`, `-1`, `0xFF` [VERIFY hex]
- Operators: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`
- Type check: `value is int`

### `float`
- Literals: `3.14`, `-0.5`, `1.0e10` [VERIFY scientific notation]
- Same operators as int
- Type check: `value is float`

### `number`
- Supertype of `int` and `float`
- Type check: `value is number`

### `string`
- Literals: `'single'`, `"double"`
- Escape sequences: `\\`, `\'`, `\"`, `\n`, `\t` [VERIFY full set]

**Methods:**
| Method | Signature | Returns | Corpus file |
|---|---|---|---|
| `size()` | `string.size()` | `int` | 013 |
| `matches(regex)` | `string.matches(string)` | `bool` | 013, 004-edge |
| `split(delimiter)` | `string.split(string)` | `list<string>` | [VERIFY] |
| `trim()` | `string.trim()` | `string` | [VERIFY] |
| `lower()` | `string.lower()` | `string` | [VERIFY] |
| `upper()` | `string.upper()` | `string` | [VERIFY] |
| `replace(from, to)` | `string.replace(string, string)` | `string` | [VERIFY] |
| `toUtf8()` | `string.toUtf8()` | `bytes` | [VERIFY] |

**Operators:**
| Operator | Example | Returns |
|---|---|---|
| `+` | `'hello' + ' ' + 'world'` | `string` |
| `==`, `!=` | `s == 'value'` | `bool` |
| `in` | `'field' in map` | `bool` |

### `bytes`
- Literals: [VERIFY — likely not used in Firestore rules directly]
- Methods: `size()` → `int`
- Type check: `value is bytes`

### `null`
- Literal: `null`
- Operators: `== null`, `!= null`

## Container Types

### `list`
- Literals: `[1, 2, 3]`, `['a', 'b']`, `[]`
- Type check: `value is list`

**Methods:**
| Method | Signature | Returns | Corpus file |
|---|---|---|---|
| `size()` | `list.size()` | `int` | 012 |
| `hasAll(list)` | `list.hasAll(['a', 'b'])` | `bool` | 012, 020 |
| `hasAny(list)` | `list.hasAny(['a', 'b'])` | `bool` | 012 |
| `hasOnly(list)` | `list.hasOnly(['a', 'b', 'c'])` | `bool` | 012, 020 |
| `join(separator)` | `list.join(',')` | `string` | [VERIFY] |
| `concat(list)` | `list.concat([4, 5])` | `list` | [VERIFY] |
| `removeAll(list)` | `list.removeAll([1])` | `list` | [VERIFY] |
| `toSet()` | `list.toSet()` | `set` | [VERIFY] |

**Indexing:**
- `list[0]` — integer index

### `map`
- Literals: `{key: value}`, `{'key': value}` [VERIFY quoted keys]
- Type check: `value is map`

**Methods:**
| Method | Signature | Returns | Corpus file |
|---|---|---|---|
| `keys()` | `map.keys()` | `list<string>` | 012, 020 |
| `values()` | `map.values()` | `list` | [VERIFY] |
| `size()` | `map.size()` | `int` | 012 |
| `get(key, default)` | `map.get('key', null)` | value or default | [VERIFY] |
| `diff(map)` | `map.diff(other)` | `MapDiff` | 007-edge |
| `affectedKeys()` | `mapDiff.affectedKeys()` | `set<string>` | 007-edge |
| `addedKeys()` | `mapDiff.addedKeys()` | `set<string>` | [VERIFY] |
| `removedKeys()` | `mapDiff.removedKeys()` | `set<string>` | [VERIFY] |
| `changedKeys()` | `mapDiff.changedKeys()` | `set<string>` | [VERIFY] |
| `unchangedKeys()` | `mapDiff.unchangedKeys()` | `set<string>` | [VERIFY] |

**Access:**
- `map.field` — dot notation
- `map['field']` — bracket notation (corpus 019)
- `map[variable]` — dynamic bracket access (corpus 019)

### `set`
- No literal syntax (created from `list.toSet()` or `mapDiff.affectedKeys()`)
- Methods: `size()`, `hasAll()`, `hasAny()`, `hasOnly()`
- `hasOnly()` on set — corpus 007-edge

## Special Types

### `timestamp`
- No literal syntax (from `request.time` or document fields)
- Type check: `value is timestamp`

**Methods:**
| Method | Returns | Notes |
|---|---|---|
| `date()` | `timestamp` | Date portion only |
| `year()` | `int` | |
| `month()` | `int` | 1-12 |
| `day()` | `int` | 1-31 |
| `hours()` | `int` | 0-23 |
| `minutes()` | `int` | 0-59 |
| `seconds()` | `int` | 0-59 |
| `nanos()` | `int` | |
| `toMillis()` | `int` | Unix milliseconds |

**Operators:**
- `>`, `<`, `>=`, `<=`, `==`, `!=` between timestamps
- `timestamp + duration` → `timestamp` (corpus 008-edge)
- `timestamp - duration` → `timestamp` [VERIFY]
- `timestamp - timestamp` → `duration` [VERIFY]

### `duration`
- Constructor: `duration.value(amount, unit)`
- Units: `'w'` (weeks), `'d'` (days), `'h'` (hours), `'m'` (minutes),
  `'s'` (seconds), `'ms'` (milliseconds), `'ns'` (nanoseconds) [VERIFY full set]
- Corpus: 008-edge

### `path`
- Literal: `/databases/$(database)/documents/collection/$(docId)`
- Interpolation: `$(expression)` inside path literals
- Used in `get()` and `exists()` calls
- Corpus: 010, 018

### `latlng`
- Constructor: `latlng.value(lat, lng)` [VERIFY]
- Properties: `.latitude`, `.longitude`
- Methods: `distance(latlng)` → `float` (meters) [VERIFY]

## Global Variables

### `request`
| Property | Type | Available in | Corpus |
|---|---|---|---|
| `request.auth` | `map` or `null` | All rules | 006 |
| `request.auth.uid` | `string` | When authed | 006, 007, 020 |
| `request.auth.token` | `map` | When authed | 006 |
| `request.auth.token.email` | `string` | When available | 021-prod |
| `request.auth.token.email_verified` | `bool` | When available | 006, 021-prod |
| `request.auth.token.phone_number` | `string` | When available | [VERIFY] |
| `request.auth.token.name` | `string` | When available | [VERIFY] |
| `request.auth.token.<custom_claim>` | varies | When set | 006 |
| `request.resource` | `map` | Write rules | 007 |
| `request.resource.data` | `map` | Write rules | 007, 020 |
| `request.time` | `timestamp` | All rules | 014, 008-edge |
| `request.method` | `string` | All rules | [VERIFY] |
| `request.path` | `path` | All rules | [VERIFY] |
| `request.query` | `map` | List rules | [VERIFY] |
| `request.query.limit` | `int` | List rules | [VERIFY] |
| `request.query.offset` | `int` | List rules | [VERIFY] |
| `request.query.orderBy` | `string` | List rules | [VERIFY] |

### `resource`
| Property | Type | Available in | Corpus |
|---|---|---|---|
| `resource.data` | `map` | Rules with existing doc | 007, 020 |
| `resource.id` | `string` | All rules | [VERIFY] |
| `resource.__name__` | `path` | All rules | [VERIFY] |

### Match variables
- `{database}` — always `(default)`
- `{docId}` — wildcard variable, available as `docId` in expressions
- `{path=**}` — recursive wildcard, matches 1+ segments

## Global Functions

| Function | Signature | Returns | Budget | Corpus |
|---|---|---|---|---|
| `get(path)` | `get(/databases/.../doc)` | `resource` | 1 of 10 | 008, 010 |
| `exists(path)` | `exists(/databases/.../doc)` | `bool` | 1 of 10 | 010, 018 |
| `getAfter(path)` | `getAfter(/databases/.../doc)` | `resource` | 1 of 10 | [VERIFY] |
| `debug(expr)` | — | — | N/A | REJECTED by production at compile (`Function not found error: Name: [debug]`) — do not use |
| `duration.value(n, unit)` | `duration.value(60, 's')` | `duration` | N/A | 008-edge |
| `math.ceil(n)` | `math.ceil(3.2)` | `int` | N/A | [VERIFY] |
| `math.floor(n)` | `math.floor(3.8)` | `int` | N/A | [VERIFY] |
| `math.round(n)` | `math.round(3.5)` | `int` | N/A | [VERIFY] |
| `math.abs(n)` | `math.abs(-5)` | `number` | N/A | [VERIFY] |
| `math.isNaN(n)` | | `bool` | N/A | [VERIFY] |
| `hashing.md5(bytes)` | | `bytes` | N/A | [VERIFY] |
| `hashing.sha256(bytes)` | | `bytes` | N/A | [VERIFY] |

Note: `math.isInfinite(n)` does NOT exist — production rejects it at compile
(`Function not found error: Name: [math.isInfinite]`) despite appearing in some
Firebase reference material.

## Operators (precedence, highest first)

| Operator | Example | Type |
|---|---|---|
| `.` (member access) | `request.auth.uid` | member |
| `[]` (index/bracket) | `data['field']`, `list[0]` | index |
| `()` (function call) | `data.keys()` | call |
| `!` (negation) | `!condition` | unary |
| `-` (unary negate) | `-value` | unary |
| `*`, `/`, `%` | `a * b` | arithmetic |
| `+`, `-` | `a + b`, `str + str` | arithmetic/concat |
| `<`, `>`, `<=`, `>=` | `a > b` | comparison |
| `==`, `!=` | `a == b` | equality |
| `in` | `'key' in map` | membership |
| `is` | `value is string` | type check |
| `&&` | `a && b` | logical AND |
| `||` | `a \|\| b` | logical OR |
| `? :` | `cond ? a : b` | ternary |

## Syntax Constructs

| Construct | Syntax | Corpus |
|---|---|---|
| Version declaration | `rules_version = '2';` | All |
| Service block | `service cloud.firestore { ... }` | All |
| Match block | `match /path/{var} { ... }` | All |
| Recursive wildcard | `match /{var=**} { ... }` | 016 |
| Allow statement | `allow op1, op2: if expr;` | 004, 005 |
| Function definition | `function name(params) { return expr; }` | 008 |
| Let binding | `let x = expr;` | [VERIFY — newer versions] |
| Single-line comment | `// comment` | 017 |
| Multi-line comment | `/* comment */` | 017 |
| Path interpolation | `$(variable)` in paths | 010, 018 |

## Items needing verification [VERIFY]

These are documented in Firebase references but not yet in the corpus.
Each needs a corpus file to confirm the syntax is accepted by the server.

1. Hex integer literals (`0xFF`)
2. Scientific notation floats (`1.0e10`)
3. Full string escape set (`\n`, `\t`, etc.)
4. `string.split()`, `string.trim()`, `string.lower()`, `string.upper()`, `string.replace()`
5. `list.join()`, `list.concat()`, `list.removeAll()`, `list.toSet()`
6. `map.values()`, `map.get(key, default)`
7. `mapDiff.addedKeys()`, `removedKeys()`, `changedKeys()`, `unchangedKeys()`
8. `latlng.value()`, `.distance()`
9. `request.method`, `request.path`, `request.query.*`
10. `resource.id`, `resource.__name__`
11. `getAfter(path)`
12. `math.*` functions
13. `hashing.*` functions
14. `debug()` function
15. `let` bindings
16. Quoted map literal keys `{'key': value}`
17. `duration` unit strings — full set
