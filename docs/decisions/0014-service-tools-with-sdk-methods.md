# 0014: Service tools carrying SDK method names

Status: Proposed; supersedes ADR-0012 Decisions 1 to 3 and Resolutions 2 and 4,
and all of ADR-0013

Date: 2026-09-09

## Context

ADR-0012 gave both surfaces one grammar. Every operation is a path of words: a
service word, an optional artifact word, and an operation word. The CLI joins
them with spaces; the bridge folded the operation word into a required `op`
field so one tool per service and artifact carried every operation of that
family. ADR-0013 withdrew the fold
five days later, on the argument that a client selects a tool by matching a
request against names and descriptions, and the operation word is the part a
request matches. It made the tool name the whole path joined with underscores,
which takes the bridge to roughly forty-one flat names.

Neither shape shipped. `main` still exposes the flat names chosen one family at
a time. The fold lived only on a branch that did not land, so ADR-0012's
Resolution 2 and every consequence ADR-0013 drew from withdrawing it describe
states the product never had. That leaves the choice genuinely open, and it was
measured rather than argued.

Three shapes were on the table: intent tools with an action discriminator; one
tool per operation with verb-first names, which ADR-0013 selects; and one tool
per service whose discriminator is the SDK's own method name. The last two were
run on the same corpus of sixty tasks, rendering the same thirty-seven
operation records, with identical execution underneath, against two agents.

On the sealed condition, where the agent had no tools but these, both shapes
completed every task: 100 percent completion each. One tool per operation cost
2.87 calls per completion against 3.47, with zero rejected calls of 172 against
9 of 208, and no run carrying a rejection against 15.0 percent of runs. On the
second agent, counting only the thirty-nine runs on each shape that engaged the
surface at all, service tools completed 39 of 39 against 38 of 39, took 2.44
calls per completion against 3.00, and drew 1 rejected call of 95 against 7 of
119. The cost split by vendor, in opposite directions, within a call per task.
Neither shape has a selection problem at thirty-seven operations.

One finding was not split. Every systematic failure came from invented
vocabulary. Nine of the ten rejections across both agents on the service shape
were a single method that pyric had named itself, with an enum value pyric had
invented, and both agents guessed a plausible word instead. Everything named
after the SDK was shaped correctly on the first call.

The decision therefore rests on scale, not on the vendor split. Six service
tools cost about 1,600 tokens where thirty-seven flat tools cost about 3,900,
and adding a capability adds a signature line to a description rather than a
tool. The surface has to grow to every Firebase service and every sandbox
capability, which is 104 methods in the full design. A flat list of 104 names is
not a surface a reader or a model can hold, and it grows by one name each time
pyric gains a capability. A closed set of service tools does not.

## Decisions

1. **One tool per service, and ten is the ceiling.** The tools are
   `firestore`, `database`, `storage`, `auth`, `messaging`, `functions`,
   `rules`, `sandbox`, `assurance`, and `ai_logic`. A new Firebase service is a
   new tool. A new capability is a new method on an existing tool. The visible
   surface never grows past ten, and adding a tool is a decision recorded here.

2. **A call is `{ method, args }`, and no name is invented.** `method` is an
   enum of the SDK's method names where an SDK method exists, and pyric's own
   exported names where none does. `getDoc`, `writeBatch`, `createUser`, and
   `subscribeToTopic` are the SDK's; `impersonate`, `crawl`, and `canIUse` are
   pyric's, and they match the CLI and the package exports. The vocabulary
   invariant is that every method record declares its `sdkOrigin`, and a record
   claiming an SDK origin must name a method that exists in that SDK. A name
   with no origin does not ship.

3. **`args` is an open object, validated on the server per method.** The
   top-level schema stays small and stable, which every client accepts, and the
   per-method schema is enforced behind it. A failure returns the tool, the
   method, the offending field, the rule, and a fix, in SDK language. Because an
   open object hides enums until the first failure, every enum is spelled in the
   method's signature line, so the model reads the allowed values before the
   first call. Each tool answers `describe(method)` with the full schema, an
   example, and the effect class.

4. **One record per method; both renderers derive from it.** The filename is
   the method, the directory is the tool. The record carries the tool, method,
   SDK origin, effect class, signature line, description, argument schema,
   validator, and handler. The tool descriptions and the CLI command table are
   generated from the records. This keeps ADR-0012 Decision 6's one-declaration
   derivation and replaces only the grammar it derived.

5. **Effect classes are enforced by the server, not advisory.** `read` changes
   no state. `write` changes sandbox state and is reversible by checkpoint.
   `destructive` replaces or discards state, and the validator refuses the call
   unless `args.confirm` is `true`. `production` touches Google infrastructure
   or real credentials, and is not mounted unless the server is started with an
   explicit flag.

6. **Reads are methods, not resources.** A read is a call on its service tool
   like any other, distinguished by its effect class.

7. **Closures and streams are not methods.** Transactions, snapshot listeners,
   value listeners, and disconnect handlers take a function, which a JSON
   argument cannot carry. They go through the sandbox tool's script method,
   which runs a module against the SDK with the app, Firestore, Realtime
   Database, auth, and Storage handles bound, logs every SDK call, and applies
   rules. That method is also the escape hatch for any SDK function that has no
   method yet, and it is what keeps ten tools sufficient.

8. **A method's result reflects the sandbox's actual state.** A verdict is the
   verdict the engine reached. A method whose name promises behavior the sandbox
   does not have is not shipped. The clock methods are the standing case: there
   is no single clock seam that the write pipeline, listeners, rules
   `request.time`, and token minting all read, so `setClock`, `advanceClock`,
   and `resetClock` ship after that seam exists and not before. The review of
   the earlier proposal found a clock method of this kind that no part of the
   sandbox read.

## What this changes

| Ruling | Status |
| --- | --- |
| ADR-0012 Decision 4, the closed service word set | Survives, as the ten tool names |
| `database` rather than `rtdb` | Survives |
| ADR-0012 Decision 6, one declaration, both surfaces derived | Survives, now one record per method |
| ADR-0012 Decision 5, transport is a property of the record | Survives |
| ADR-0012 Decision 1, service-first tool naming and the `op` field | Withdrawn |
| ADR-0012 Decision 2, the binary name as a service word | Withdrawn; those operations move to `assurance` and `sandbox` |
| ADR-0012 Decision 3, artifact omitted for the service itself | Withdrawn; there is no artifact word |
| ADR-0012 Resolution 2, the fold and the `op` enum | Withdrawn |
| ADR-0012 Resolution 4, `set` replacing `create` | Withdrawn; the SDK's names decide |
| ADR-0013 Decision 1, the whole path as the tool name | Withdrawn |
| ADR-0013 Decision 3, one record per operation named by its path | Replaced; one record per method, named by the method |
| Reads rendered as resources | Withdrawn |

## Consequences

- Surface size stops tracking capability count. Six service tools rendering
  thirty-seven operations cost about 1,600 tokens against 3,900 for the same
  operations as thirty-seven flat tools. The full design, 104 methods behind ten
  tools, is on the order of 3,000 tokens, still less than the flat rendering of
  a third as many operations.
- Growth is a signature line. A new capability adds a record and one line to a
  tool description. A new Firebase service adds one tool, until ten.
- The CLI reads `pyric <tool> <method> --arg value`, generated from the same
  records, so a reader who knows one surface can predict the other. That was
  ADR-0012's original goal and it survives the change of grammar.
- The eval harness measures completion, first call accepted, rejected calls,
  error calls, and calls per completed task, from the server-side event log, and
  reruns in about an hour. Two findings would reopen this decision: a third
  vendor showing a completion gap rather than a cost gap, or a count experiment
  showing the flat shape degrading past thirty-seven operations where the
  service shape does not. Neither has been run. The corpus gains tasks for each family as it
  lands, and the sweep reruns after the naming corrections and again after the
  assurance methods.
- Two open questions. First, how the vocabulary invariant attests a
  pyric-origin name: SDK origins can be checked against the SDK, and pyric
  origins currently rest on a reviewer reading the record. Second, whether the
  second agent gets a sealed condition. A third of its runs never touched the
  surface, because the corpus sat inside its trusted workspace and it answered
  from the task file, so its numbers cover only the runs that engaged.

ADR-0012 and ADR-0013 keep their files. ADR-0012's status line becomes
"Accepted; Decisions 1 to 3 and Resolutions 2 and 4 superseded by ADR-0014",
and ADR-0013's becomes "Superseded by ADR-0014". Neither file is edited by this
change beyond that line.
