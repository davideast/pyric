import { row } from './section.ts';

export default row({
  order: 160,
  featureKeys: [],
  behavior: "`resource.name` (full object path), `resource.timeCreated`, `resource.updated`, `resource.bucket` — the object-identity and time fields of the existing-object binding, plus `duration.value(n, unit)`, and `request.resource.name`, the incoming object's full path in the same form",
  status: "conforms",
  evidence: "ROW CORRECTED, 2026-07-12: the fields are now modeled, sourced from the persisted object record. `oracle:rules-storage-resource-object-identity` matches production verdict-for-verdict on all 9 cases — an extension guard (`resource.name.matches`), a freshness window (`resource.timeCreated + duration.value(1, 'h')`), an immutability check (`resource.timeCreated == resource.updated`), and an absent-property negation. Production semantics pinned by the capture: `resource.name` is the object's FULL path within the bucket (GCS object-name convention, sourced from the persisted record's `fullPath`, not the client SDK's last-segment `name`); `timeCreated`/`updated` are timestamps (production rejects an int with \"Unsupported operation error. Received: int < timestamp\"); the update-time field is `updated` — there is NO `resource.timeUpdated`. An absent property is an evaluation error that absorbs to DENY and SURVIVES negation, so `resource.name != 'x'` on an object with no name denies rather than false-allowing. The prior row recorded these fields as an unsupported gap; that gap is closed. RECAPTURED, 2026-09-28: the scenario adds 5 production cases (14 in all). `request.resource.name` on a create is the incoming object's full path, so `split('/')[1]` is the file segment of `named/a.png`; a delete carries no `request.resource`, so reading its name is \"Property resource is undefined on object.\" and the `!=` comparison still denies; `resource.name.split('/')[1]` on a get is the file segment; and a segment index past the end is \"Index out of bound error. Index: [2] , size: [2].\", which survives negation. The evaluator matches production on all 14 cases.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-resource-object-identity"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.binding.request.resource.name","storage.binding.resource.name","storage.binding.resource.timeCreated","storage.binding.resource.updated","storage.binding.resource.bucket","storage.function.duration.value"],
});
