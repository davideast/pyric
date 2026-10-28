/**
 * The bundle the import map serves for `firebase/firestore`.
 *
 * The page runtime deploys the project's rules (and seed, persistence, bridge)
 * with top-level await, so app code that imports this entry runs after them.
 * `firebase/auth` cannot import it: Service Workers reject top-level await (#697).
 * The SDK surface lives in `./firestore-surface.js`, which a Node process that
 * `@pyric/cli/register` activated imports without the page runtime (#1082).
 */
import './init.js';
import './runtime.js';
export * from './firestore-surface.js';
