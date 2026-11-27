# AI-JRPG voice clip access

The claim pins `storage.rules` at AI-JRPG revision `b3bed5e36acaa7bfc47a600e86e015fb84b1ac70`. The rule reads the caller’s authentication, the object path, the incoming content type and byte count. The near-limit uploads supply actual byte arrays of 2,097,151, 2,097,152 and 2,097,153 bytes. The wrong-MIME control sends the same 256 bytes as the WAV control.

The live controller creates a UUID-labelled, private, nondefault bucket in the sandbox project and links it to Firebase. Two separate Firebase apps hold an anonymously signed-in Firebase user and a signed-out client. The controller seeds the lifecycle object independently through Google Cloud Storage so a refused creation still leaves a real object for reads, overwrite and delete. A successful upload on a separate, signed-only transport-control release records its SDK-reported content type, size and generation alongside a generation-pinned independent byte readback.

Signed SDK reads of a known object witness the transitions from closed to control, back to closed, then to the exact source release. The captured operations use the production Firebase Storage SDK. Privileged GCS reads check each object's existence, metadata, generation and SHA-256 immediately before and after each SDK operation. The controller restores and verifies its closed rules, deletes only the named test objects with generation preconditions, removes this release and unlinks and removes its newly created bucket.

`replay.mjs` scores the installed Pyric candidate against the captured verdicts. A local mutation changes the strict byte bound to an inclusive bound. The reviewed importer verifies the completed run against the independently retained archive before accepting observations. The first exploratory capture stopped after its initial signed upload was refused and a dependent read hit an absent object. That run restored its closed rules and cleaned up its bucket. A second run recorded all 11 decisions with a successful transport control, but the host wall-clock timestamps did not verify the post-activation settle interval. The admitted run uses the shared monotonic evidence clock; its receipt contains the signed transport control and independent setup.

## Observed decisions

| SDK operation | Signed state | Live result | Independent readback |
| --- | --- | --- | --- |
| Create a new WAV | In | ALLOW | 256 bytes with the submitted SHA-256 |
| Read the seeded WAV | In | ALLOW | SDK-returned bytes match GCS |
| Read or overwrite the seeded WAV | Out | DENY for both | Original generation and bytes |
| Overwrite with audio/mpeg | In | DENY | Original generation and bytes |
| Overwrite with a second WAV payload | In | ALLOW | New generation and second digest |
| Delete the overwritten WAV | In | DENY | New generation and second digest remain |
| Upload 2,097,151 bytes | In | ALLOW | Exactly 2,097,151 bytes, audio/wav |
| Upload 2,097,152 or 2,097,153 bytes | In | DENY for both | Both object paths absent |
| Upload a valid WAV under other/ | In | DENY | Object absent |

The independent transport control accepted a 256-byte upload and stored it as audio/wav. The inclusive-bound mutation changes only the 2,097,152-byte verdict. [Live receipt](probes/clip-objects/v1/evidence/031dfbf6-5494-4434-8eed-a483a875d775.json)
