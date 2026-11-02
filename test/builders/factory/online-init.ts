/** Where the init script that makes pages report `navigator.onLine` as true is, for the walk runner and for a session's own driver. */
import { fileURLToPath } from 'node:url';

export const ONLINE_INIT_SCRIPT = fileURLToPath(new URL('./online-init.js', import.meta.url));

/** The environment variable that names it in a session. */
export const ONLINE_INIT_ENV = 'PYRIC_BUILDER_ONLINE_SCRIPT';
