/**
 * Production-project discovery adapter.
 *
 * Kept as an explicit, isolated entry for issue #264 so credential-free
 * discovery does not load token-bearing REST behavior. Issue #265 removes
 * this adapter and its consumers.
 */

export * from './rest-crawler-firestore.js';
