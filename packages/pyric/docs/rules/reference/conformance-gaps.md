# Firestore rules gaps: where pyric and Firebase disagree

A gap is a rule that gets one answer from pyric and a different answer from
Firebase. You write the rule once. pyric allows the request and Firebase
denies it, or the other way round. The rule you tested is not the rule you
shipped.

Every gap on this page was captured from the production Rules Test API, not
inferred. There are seven. Skim the headings. If none of them names something
your rules use, none of them affects you.

Tracked in [#135](https://github.com/davideast/pyric/issues/135).

## How severity works

Severity is the direction of the disagreement. Nothing else decides it.

**Critical: pyric allows, Firebase denies.** pyric's copy of your rule is
more permissive than the real one. A guard that passed on your machine passed
for a reason that does not hold in production. This is the highest severity
the system has. Every gap in this direction is Critical, however narrow its
trigger looks, because the whole point of a local mirror is that a verdict you
get here is the verdict you get there.

**Low: pyric denies, Firebase allows.** The local mirror is stricter than
production. This is annoying, not dangerous. You find it immediately: the
operation fails on your machine and works in the cloud.

There is no tier between them. A gap is one direction or the other. Six of the
seven below are Critical. One is Low.

## Critical: hashing built-ins allow in pyric and deny in Firebase

### What you would write

A rule that gates on a digest. An upload token, a content checksum, a
signature check:

```
match /docs/{id} {
  allow create: if request.auth != null
    && hashing.sha256(request.resource.data.body).toHexString()
       == request.resource.data.checksum;
}
```

Or any use of `hashing.md5()`, `hashing.crc32()`, `hashing.crc32c()`, or
`Bytes.toBase64()`.

### What happens

In pyric the digest comes out equal to the reference value and the write is
ALLOWED. In Firebase the same comparison is DENIED.

pyric's byte encoding and hash output do not agree with production's. That is
a verdict-level fact, not a theory about which byte differs. On all five
captured cases, including the textbook md5 of the empty string and the NIST
sha256 of `abc`, pyric says allow and production says deny.

Any rule whose decision depends on a hash value or a base64 encoding passes
locally and fails in the cloud.

### What you should do

Do not gate access on a hash comparison. Compute the digest in your
application, store it as a field, and let the rule compare fields. That runs
identically in both engines.

`toHexString()` and `toUtf8().size()` agree with production. The digest
functions and `toBase64()` do not.

## Critical: `getAfter()` and `existsAfter()` allow in pyric and deny in Firebase

### What you would write

A post-write check, usually to keep two documents consistent:

```
match /orders/{id} {
  allow create: if request.auth != null
    && existsAfter(request.path) == true
    && getAfter(request.path).data.total == request.resource.data.total;
}
```

### What happens

In pyric the write is ALLOWED. pyric models the post-write state and hands
back the document you are about to write.

In Firebase the write is DENIED. A `getAfter()` result carries no document
identity in the response, so a comparison against it errors, and an errored
expression denies. `existsAfter()` diverges the same way on a create, on a
delete, and over an unrelated path. All four captured cases: pyric allow,
production deny.

The production verdict here comes from a mocked post-write lookup in the Rules
Test API. That API is the only oracle there is for a rule that reads state the
request has not committed yet, and it denies where pyric allows.

### What you should do

Do not write rules that depend on `getAfter()` or `existsAfter()`. You cannot
test them here and get an answer that means anything. Where the rule is really
about the write in front of you, use `request.resource.data`, which agrees on
both sides.

## Critical: `.id` and `__name__` on a `get()` result allow in pyric and deny in Firebase

### What you would write

A rule that reads the identity of a document it looked up:

```
match /pages/{id} {
  allow create: if get(/databases/$(database)/documents/cfg/site).id == 'site';
}
```

### What happens

In pyric the write is ALLOWED. pyric attaches a document identity to the
`get()` result, so `.id` and `__name__` read back the path you asked for.

In Firebase the write is DENIED. The looked-up document carries no identity in
the response, so `.id` errors with "Property id is undefined on object" and
the rule denies. `__name__` behaves the same. The production verdict comes
from a mocked lookup in the Rules Test API, which is the oracle for every
cross-document read in these captures.

### What you should do

Read data off a `get()`, not identity. `get(...).data.<field>` matches
production exactly, and so does `exists(...)`.

```
allow create: if get(/databases/$(database)/documents/cfg/site).data.open == true;
```

If you need the identity, you already have it. It is the path you passed to
`get()`.

## Critical: `request.query` allows in pyric and denies in Firebase

### What you would write

A rule that inspects the query on a request that is not a list:

```
match /notes/{id} {
  allow create: if request.auth != null
    && request.query is map
    && request.query.size() == 0;
}
```

### What happens

In pyric the write is ALLOWED. pyric models `request.query` as an empty map on
a `get`, `create`, `update`, or `delete`. In Firebase the same comparison is
DENIED.

### What you should do

Only touch `request.query` inside a `list` rule, which is the only request
that has one. On a document request, drop the check.

## Critical: out-of-range slices allow in pyric and deny in Firebase

### What you would write

A slice whose end index runs past the end of the value:

```
match /notes/{id} {
  allow create: if request.resource.data.tags[1:99].size() == 3
    && request.resource.data.title[6:99] == 'world';
}
```

### What happens

In pyric both slices clamp to the length of the list or the string, the
comparison succeeds, and the write is ALLOWED. In Firebase an out-of-range
slice end is DENIED, on lists and on strings alike.

### What you should do

Never slice past the end. Check the size first, or slice with an index you
know is in range:

```
allow create: if request.resource.data.tags.size() >= 4
  && request.resource.data.tags[1:4].size() == 3;
```

In-range slices, empty slices (`[i:i]`), and full-length slices all agree with
production.

## Critical: `path()` on a value that is already a path allows in pyric and denies in Firebase

### What you would write

A `path()` call wrapped around something that is already a `Path`, usually
because it came out of a helper:

```
function asPath(p) {
  return path(p);
}
match /users/{uid} {
  allow read: if asPath(path('users/alice')) == path('users/alice');
}
```

### What happens

In pyric `path()` is idempotent. Passing it a `Path` gives the same `Path`
back and the read is ALLOWED. In Firebase the same expression is DENIED.

### What you should do

Call `path()` exactly once, on a string. Everything else about paths matches
production: `path()` on a string literal, equality and inequality, `bind()`,
numeric indexing, and type checks.

## Low: a float in your test data reads as an int in pyric

### What you would write

A type check on a number in the payload:

```
match /readings/{id} {
  allow create: if request.resource.data.x is float
    && !(request.resource.data.x is int);
}
```

### What happens

In pyric the write is DENIED. In Firebase it is ALLOWED.

Firestore stores a type tag next to the number, so a value written as a float
stays a float. pyric reads test data from JSON, where `2.0` and `2` are the
same number, and narrows it toward int.

This is the safe direction. pyric refuses a write production accepts, so you
see it in front of you and nothing surprising happens after you deploy.

### What you should do

Do not use `is float` or `is int` to tell payload numbers apart while testing
locally. Test the property you actually care about, which is usually a range:

```
allow create: if request.resource.data.x is number
  && request.resource.data.x >= 0
  && request.resource.data.x <= 100;
```

Integer division, truncation, modulo, division by zero, and `is int` on a
genuinely integral value all match production.

## Everything else in the simulator matches Firebase

Sixteen of the twenty-three captured observations replay clean, case for case:
time and math built-ins, durations and geopoints, cross-type operator
overloads, error absorption in `&&` and `||`, user-defined functions and
recursive rules, list and string methods, `List.concat()` / `removeAll()` /
`toSet()`, `Map.get()` with defaults and nested paths, `matches()` as an
anchored full-string regex, own-keys-only map membership with no prototype
leakage, required-field checks and `mapDiff`, set algebra, string literals and
regexes, timestamp math and casts, undefined-field access, and the
unsupported-feature witness.

## How this is checked, and how to check it yourself

Each gap above is replayed on every test run. The suite loads each captured
production observation, runs the same ruleset and the same request through the
local simulator, and compares verdicts case for case.

- Suite: `packages/pyric/test/rules/oracle-conformance.test.ts`. Run it with
  `bun test packages/pyric/test/rules/oracle-conformance.test.ts`.
- Captures: `packages/conformance/observations/firestore-rules/*.json`,
  twenty-three of them.
- Rulesets and cases: `packages/conformance/rules-corpus/firestore/`.

The observation and case keys behind each section above:

| Gap | Observation :: cases |
|---|---|
| Hashing built-ins | `rules-firestore-bytes-toutf8-and-hashing` :: `toBase64 round-trip`, `md5 empty string`, `sha256 abc`, `crc32 IEEE 802.3 ref`, `crc32c Castagnoli ref` |
| `getAfter()` / `existsAfter()` | `rules-firestore-get-after-and-exists-after` :: `getAfter target == request.resource.data`, `existsAfter create true`, `existsAfter delete false`, `existsAfter unrelated mocked path` |
| `get()` result identity | `rules-firestore-get-missing-doc` :: `get(mocked).id == 'site'`, `get(mocked).__name__ == path literal` |
| `request.query` | `rules-firestore-globals-request-path-and-resource-id` :: `request.query empty map` |
| Out-of-range slices | `rules-firestore-range-slice-list-and-string` :: `list slice end OOB clamps to length`, `string slice end OOB clamps to length` |
| `path()` idempotence | `rules-firestore-path-constructor-and-bind` :: `path() idempotent on Path arg` |
| Float payload reads as int | `rules-firestore-int-float-and-division` :: `float payload is float / not int` |

Every gap is pinned in the suite's `KNOWN_DIVERGENCES` table, which asserts
both sides: production's captured verdict and the simulator's live verdict.
The suite is green while a gap is exactly as described. It fails the moment
either side moves, including when someone fixes the simulator, which forces
the fix to delete the pin instead of landing silently beside a stale one. No
divergent case is skipped.

A third outcome is not a gap. The simulator can answer UNSUPPORTED, an
explicit refusal to evaluate a construct it does not model. A refusal is loud
and you cannot mistake it for a verdict, so those cases are recorded and not
asserted against production.

## Where to look next

- [Storage rules gaps](../../storage/reference/conformance-gaps.md) for the
  same page on the storage side.
- [Compatibility matrix](../COMPAT.md) for the row-by-row registry.
