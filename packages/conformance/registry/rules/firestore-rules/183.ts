import { row } from './section.ts';

export default row({
  order: 240,
  featureKeys: [],
  behavior: "Resource identity (`resource.id`/`resource.__name__`/`request.resource.id`) on an EXISTING document (RULES-B12) — production leaves the identity keys ABSENT, so reading one errors → DENY, the error survives negation, and only a determining `||` operand absorbs it",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-12: production capture proves the simulator matches the production Firestore Rules Test API verdict-for-verdict on all 13 cases. Production builds `resource` (and `request.resource`) from the supplied document alone and derives NO identity from the request path, so `resource.id`/`resource.__name__`/`request.resource.id` read as absent properties — verbatim `Property id is undefined on object.` / `Property __name__ is undefined on object.` — which absorb to DENY. The simulator previously SYNTHESIZED `id`/`__name__` from the request path on get/list/update/delete, so `resource.id == id` ALLOWed where production DENIES: an over-permissive divergence, now removed. The negation cases (`resource.id != 'zzz'`, `!(resource.id == 'zzz')`) pin that the absent read is a propagating error rather than a false, which an absent-as-undefined model would false-ALLOW. `oracle:rules-firestore-resource-document-identity` — replayed by `unit:rules/oracle-conformance.test.ts`.",
  oracleObservations: ["rules-firestore-resource-document-identity"],
  constructs: ["firestore.binding.resource.id","firestore.binding.resource.__name__","firestore.binding.request.resource.id","firestore.binding.resource.data","firestore.binding.request.resource.data"],
});
