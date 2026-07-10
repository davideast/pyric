/**
 * Shared corpus types for the Storage rules conformance chain.
 *
 * Mirrors the Firestore corpus (../firestore/types.ts). The `StoragePack`
 * shape is the SINGLE source consumed by:
 *   - the capture runner (scripts/oracle/run-rules-storage.ts), and
 *   - the replay suite (packages/pyric/test/storage/rules-oracle-conformance.test.ts).
 *
 * A pack is a self-contained conformance unit: one `service firebase.storage`
 * ruleset plus the cases that exercise it. It reuses the Firestore corpus's
 * `Pack` provenance fields (`id` / `fm` / `rationale` / `rules`) verbatim; the
 * only shape difference is `cases`, which are Storage-shaped
 * (`StorageTestCase`, the request carries `size`/`contentType`/`metadata`
 * rather than Firestore's `resource.data`) and hand off directly to either the
 * production Rules Test API client or the in-process `evaluateStorageRules`.
 */
import type { Pack } from '../firestore/types.ts';
import type { StorageTestCase } from '../../../../packages/pyric/src/rules/test/spec.ts';

/**
 * A Storage rules conformance pack. Same provenance fields as the Firestore
 * {@link Pack} (so the two corpora stay legible side by side), with
 * Storage-shaped cases.
 */
export interface StoragePack extends Omit<Pack, 'cases'> {
  /** Stable identifier. Doubles as the observation filename stem:
   *  `rules-storage-<id>.json`. Must be unique across the corpus. */
  id: string;
  /** Failure-mode / ledger tag. */
  fm: string;
  /** One line: why this pack should reveal something. */
  rationale: string;
  /** The `service firebase.storage` ruleset under test. */
  rules: string;
  /** The cases to run against `rules`. Each `description` is unique within the
   *  pack and is the verdict-table key in observations. */
  cases: StorageTestCase[];
}

export type { StorageTestCase };
