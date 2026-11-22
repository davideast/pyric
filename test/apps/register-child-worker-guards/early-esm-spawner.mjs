import { spawnSync } from 'node:child_process';

// Imported before `@pyric/cli/register` loads (#1652 item 1): `Module.syncBuiltinESMExports()`
// must update this live ESM binding when `installChildProcessGuard` wraps `child_process`.
globalThis.__earlyEsmSpawnSync = (...args) => spawnSync(...args);
