/**
 * `pyric-tools/bridge` — Node-side entry.
 *
 * Resolved by the `node` condition in `package.json`'s exports map.
 * Exports the bridge core (`createBridge`) and the standalone server
 * (`startServer`). The Vite integration is the `pyricSandbox({ bridge })`
 * plugin in `pyric-tools/vite` (the firebase→sandbox swap AND the bridge in
 * one plugin), not a bridge-only plugin here.
 *
 * The browser-side `connectBridge` lives in `./client.ts` and is
 * resolved by the `browser` condition. Wire format shared by both
 * lives in `./protocol.ts` (type-only, no runtime imports across the
 * boundary).
 */

export type { BridgeMode, HealthReport } from './protocol.js';
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

// Prod-mode confirmation surface — exported so callers wiring their
// own startServer flow (Electron apps, custom dev servers) can plug
// in non-default confirm handlers.
export {
  createInteractiveConfirmHandler,
  createAutoApproveHandler,
  createDenyAllHandler,
  createPolicyHandler,
  hasInteractiveTTY,
} from './server/confirm.js';
export type {
  ConfirmHandler,
  ConfirmRequest,
  ConfirmDecision,
  ConfirmPolicy,
  InteractiveOptions,
  PolicyHandlerOptions,
} from './server/confirm.js';
export {
  DEFAULT_PROD_POLICIES,
  DEFAULT_SANDBOX_POLICY,
  FALLBACK_PROD_POLICY,
  buildPolicyMap,
  policyFor,
} from './server/confirm-policy.js';
export type { PolicyOverrides } from './server/confirm-policy.js';
