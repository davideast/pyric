# Host-controlled generation

Approved implementation: full workflow, explicit Resume, policy + compilation + isolated startup gates, initial attempt plus two automatic repairs per validation stage. Firestore is durable truth; SharedWorker and @inbrowser/resumable execute and stream progress. Git and OPFS are deferred.

Stages: capture immutable input -> permission plan -> modular policy source -> independent permission cases -> host resolve/lint/standalone+sandbox validation -> UI selection -> React source -> compile -> isolated startup (15s ready, 2s settling) -> immutable candidate. Preserve existing review/activation and policy protections. No agent commands for mandatory host work, no global tool-turn budget.

Build metadata holds revision, lease (60s, renewed every20s), stage, status, checkpoint pointer. Immutable checkpoints hold UTF-8 artifact chunks <=256KiB, content hashes, workspace files, frozen inputs/references, budgets, compatibility, evidence. Upload artifacts before a fenced transactional pointer update. Partial uploads are not recoverable state. No model calls after failed checkpoint acknowledgement. Stable content IDs make acknowledgements retryable. Only authored files/host metadata; no caches, dependencies, Git or credentials.

Authenticated tabs own Firestore and isolated startup; SharedWorker RPCs require acknowledgement. Missing tabs pause execution. Reject stale executors, changed identity/drafts/active versions. Sign-out cancels. Discover builds from Firestore without local job IDs; Resume never implicitly starts another model request. Preserve completed responses and attempt budgets; interrupted streams restart only their current request. Compatibility changes invalidate relevant evidence. Explicit Retry stage records another attempt group; Start over uses the saved draft.

Progress UI distinguishes running/paused/attention/ready, expands diagnostic events, and spins only during actual execution. Checkpoint artifacts owner-only. Extend permanent deletion to descendants. Preserve legacy app versions/builds; old output must be revalidated before promotion.

Tests: public workspace, Pyric rules/sandbox and browser boundaries. Cover stage/budget behavior, checkpoint interruptions/corruption/idempotence/offline, competing executors, identity/draft/version changes, unsupported policy/parity, startup repair/isolation, browser Resume with lost local state, single candidate persistence, legacy activation safety.
