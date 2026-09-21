# Approval boundary and next live phase

No Cloud Run deployment or real inference occurred in this implementation. The CLI
accepts only the controlled local provider. `config/live.example.json` is an operator
worksheet, deliberately rejected by preflight. Neither production flags nor model
names silently enable inference.

The prepared `adapters/ai-logic.mjs` implements the inspected GoogleAI HTTP generation
path. Its HTTP tests use loopback fixtures. This is not evidence about real provider
cancellation, real throughput, or parity with all Firebase SDK behavior. STOP and
MAX_TOKENS on a fully consumed, single-candidate response are its only accepted
normal terminal markers; other outcomes conservatively remain unknown. Usage is
metadata when returned, not a billing assertion. Cancellation and lookup explicitly
return unsupported without making invented API requests.

Before requesting approval, prepare a concrete project, Firebase app, model, App
Check and Firebase Auth credential mechanism, and transport path. Keep credentials
out of configuration/captures. Implement a shared durable run budget across cases
and gateway restarts, and integrate the real adapter into that gateway. The current
local sessions intentionally isolate cases and terminate their fixture processes;
that cleanup cannot be used to clear real unknown operations.

Initial proposed live cases, one repetition each:

| Case | Maximum calls | Prerequisite |
| --- | ---: | --- |
| Complete non-streaming response | 1 | Approved model supports bounded generation |
| Complete stream | 1 | Same model supports streaming |
| Abort before dispatch | 0 | Explicit pre-dispatch barrier |
| Abort after first chunk | 1 | Consume a real chunk before aborting |

Hard upper limits: 12 total dispatch attempts, 2 concurrent reservations, 64 output
tokens per call, 30-second request deadlines, 180-second controller deadline. The
planned cases need only 3 dispatches; the ceiling is not permission to add retries.
Direct fetch performs one attempt; any future SDK retry behavior must be disabled
or charged. These bounds are not a dollar ceiling.

Unknown remote operations retain their slot across cases, deadlines, disconnects
and controller restarts. Stop the phase if capacity is exhausted. Do not duplicate
dispatch keys, claim a remote stop, or issue status lookups without new documented
capabilities. Mark unsupported behavioral cases unexecuted. Do not infer provider
termination from elapsed time or an exhausted output-token budget.

For browser → Cloud Run → AI Logic evidence, first implement and obtain approval
for that deployment; direct local HTTP evidence must retain its different path
label. Preserve sanitized provider observations and captured Cloud Logging using
`providerContractExperiments` scopes. Match normalized fields and fault schedules,
but report capability differences rather than pretending fixture/model latency is
comparable. No live capture comparison is implemented yet; current `compare` checks
only source-identical controlled captures.
