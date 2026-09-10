/**
 * The storage service a sandbox is running: its store, the ruleset it
 * enforces, and the cross-service IAM posture it evaluates Firestore lookups
 * under.
 *
 * This is the mutable half of the surface. The factory in `storage/service.ts`
 * decides when one of these is created and which sandbox it belongs to; what
 * one holds while it is running is here, because that is what enforcement,
 * rule replacement, and posture replacement all reach for and none of them
 * needs the factory's caching to say it.
 */
import type { StorageBackend } from '../persistence.js';
import type { StorageRules } from './rules.js';

/**
 * Cross-service IAM posture for `firestore.get()/exists()` in Storage rules.
 *
 * Production Storage rules can read Firestore ONLY when the project's
 * Storage service agent holds `roles/firebaserules.firestoreServiceAgent`.
 * `'granted'` (the default, the common configured-project state) serves
 * lookups from the same-sandbox Firestore store; `'denied'` makes every
 * EXECUTED lookup fail exactly like production without the role (error to
 * rule denies), while short-circuited lookups are never executed and stay
 * unaffected. Captured boundary: conformance observation
 * `stdlib-realstorage-p3-lookup-budget` (registry row storage-rules#134).
 */
export type CrossServiceIam = 'granted' | 'denied';

/**
 * Internal sandbox service: owns the IDB connection and the parsed rules.
 * Only constructed inside the sandbox `getStorageSandbox` path.
 */
export class StorageService {
  constructor(
    readonly backend: StorageBackend,
    /**
     * The ruleset every operation on this service evaluates against.
     * Assigned at construction and reassigned only by `replaceStorageRules`,
     * which is the one deliberate way to install a new ruleset into a sandbox
     * whose storage is already open.
     */
    public rules: StorageRules | null = null,
    /**
     * The cross-service IAM posture every operation on this service evaluates
     * `firestore.get()/exists()` under. Assigned at construction and
     * reassigned only by `replaceCrossServiceIam`, which is the one deliberate
     * way to move a sandbox whose storage is already open between the granted
     * and denied project states.
     */
    public crossServiceIam: CrossServiceIam = 'granted',
  ) {}
}
