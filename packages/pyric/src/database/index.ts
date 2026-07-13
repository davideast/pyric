/**
 * `pyric/database` — sandbox-only mirror of `firebase/database`.
 *
 * Production selection happens before this module loads: canonical
 * `firebase/database` imports either remain Firebase or are swapped to this
 * package by the Vite/import-map or Node register boundary.
 */
export * from './modular.js';
