# Remote build diagnostics

For a phone connected through Tailscale, open Kin with `?kinDiagnostics=1` before the route hash. This enables metadata reporting for 15 minutes in that tab, including its generation worker. Reloading the opt-in URL starts a new trace. Use `?kinDiagnostics=0` to stop reporting from the tab; an already attached worker expires at the original deadline or receives the disabled setting on its next attachment.

The Vite-only receiver writes `kin-remote-diagnostics.jsonl` in the server's OS temporary directory. It keeps approximately 1 MB, then starts the file again. This is local diagnostic storage, not Firestore or a hosted telemetry service. Production builds do not emit reports and do not mount the receiver.

Events use a random trace ID, server receipt timestamp, fixed event/stage names, optional elapsed milliseconds, and one of `timeout`, `aborted`, or `error`. No prompts, generated code, family data, identifiers, model output, raw exception messages, or credentials are sent. Both sender and receiver allowlist fields. The receiver rejects unknown fields and caps request size and rate. Delete the local log after diagnosis.

Interpret the last events:

- `draft-load-start` or `app-load-start` without its end/failure: data loading is pending.
- `checkpoint-start` without end/failure: checkpoint persistence is pending.
- `model-wait` without `model-connected`: model/port acquisition is pending.
- `model-stream-open` without `model-first-chunk`: the model stream has not delivered a chunk yet.
- `ai-probe-ok`: the existing backend port answered the worker's fast version handshake. This proves responsiveness, not provider health or full sandbox initialization.
- `ai-probe-failed`: the backend port did not answer that probe within five seconds.
- `model-first-chunk` followed by timeout: the stream stopped making progress, or its final response never resolved.
- `ai-port-reused`: a returning tab offered a new backend port but the generation worker retained its first one.

The probe is read-only and does not gate or retry generation. The worker name was revised to load this instrumentation; the first diagnostic run therefore uses a fresh generation worker. Existing durable checkpoints remain available. A successful fresh run alone does not prove that an earlier stale-worker problem is fixed.
