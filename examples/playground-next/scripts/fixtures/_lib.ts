/**
 * Tiny shared helpers for fixture probes. NOT imported from the
 * fixtures themselves — fixtures are appSource that runs inside the
 * preview iframe and can't import workspace modules. Instead, every
 * fixture inlines this same shape via copy/paste. The file is kept
 * as documentation of the convention and to make the contract
 * grep-able.
 *
 * Each fixture's `App` component:
 *
 *   1. Runs a scripted async flow inside a single `useEffect`.
 *   2. Logs progress via `console.log('[<probe-name>] <message>')`.
 *   3. Ends with EXACTLY ONE of:
 *      console.log('[<probe-name>] DONE ok')
 *      console.log('[<probe-name>] DONE fail: <reason>')
 *   4. Catches all throws; converts them into a DONE fail line.
 *
 * The runner (`scripts/run-fixtures.ts`) treats absence of the DONE
 * line as a timeout (= fail). One DONE marker per probe, ever.
 */
export const PROBE_CONTRACT_VERSION = 1;
