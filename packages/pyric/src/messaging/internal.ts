/**
 * `pyric/messaging/internal` — adapter-only protocol surface for the
 * messaging broker, on the `pyric/sandbox/internal` / `pyric/storage/internal`
 * precedent: `pyric-admin/messaging` (and later the worker host's
 * `messaging.*` op handlers) reach the per-sandbox {@link MessagingBroker}
 * through this subpath.
 *
 * **Not part of the public API.** Shape subject to change without
 * breaking-change semantics across versions.
 */
export * from './broker/index.js';
