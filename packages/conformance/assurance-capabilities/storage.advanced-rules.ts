import type { AssuranceCapabilityRecord } from './types.ts';

/** Everything past the coarse subset: granular verbs, user-defined functions,
 *  time comparisons, regex, server-populated object timestamps, and
 *  cross-service Firestore lookups from a Storage ruleset. */
export const capability: AssuranceCapabilityRecord = {
  service: 'storage',
  description: 'Granular verbs, functions, time, regex, and Firestore rule lookups.',
  dependencies: [
    { kind: 'construct', id: 'storage.rule-kind.allow-get' },
    { kind: 'construct', id: 'storage.rule-kind.allow-list' },
    { kind: 'construct', id: 'storage.rule-kind.allow-create' },
    { kind: 'construct', id: 'storage.rule-kind.allow-update' },
    { kind: 'construct', id: 'storage.rule-kind.allow-delete' },
    { kind: 'construct', id: 'storage.rule-kind.function' },
    { kind: 'construct', id: 'storage.rule-kind.let' },
    { kind: 'construct', id: 'storage.method.string.matches' },
    { kind: 'construct', id: 'storage.function.timestamp.date' },
    { kind: 'construct', id: 'storage.function.timestamp.value' },
    { kind: 'construct', id: 'storage.function.firestore.get' },
    { kind: 'construct', id: 'storage.function.firestore.exists' },
    { kind: 'construct', id: 'storage.binding.request.time' },
    { kind: 'construct', id: 'storage.binding.resource.name' },
    { kind: 'construct', id: 'storage.binding.resource.timeCreated' },
    { kind: 'construct', id: 'storage.binding.resource.timeUpdated' },
    { kind: 'registry-row', id: 'storage-rules#116' },
  ],
};
