/**
 * `@pyric/cli/bridge` — Node-side entry.
 *
 * Resolved by the `node` condition in `package.json`'s exports map.
 * Exports the bridge core (`createBridge`) and the standalone server
 * (`startServer`). The Vite integration is the `pyric({ bridge })`
 * plugin in `@pyric/cli/vite` (the firebase→sandbox swap AND the bridge in
 * one plugin), not a bridge-only plugin here.
 *
 * The browser-side `connectBridge` lives in `./client.ts` and is
 * resolved by the `browser` condition. Wire format shared by both
 * lives in `./protocol.ts` (type-only, no runtime imports across the
 * boundary).
 */

export type { HealthReport } from './protocol.js';
export {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_HEALTH_PATH,
  DEFAULT_MCP_PATH,
  DEFAULT_SANDBOX_PATH,
} from './protocol.js';

export { createBridge } from './server/bridge.js';
export type { Bridge, BridgeOptions } from './server/bridge.js';

export { startServer } from './server/standalone.js';
export type { ServerHandle, StartServerOptions } from './server/standalone.js';
