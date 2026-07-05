/**
 * `pyric-tools/bridge` — browser-side entry.
 *
 * Resolved by the `browser` condition in `package.json`'s exports map.
 * Exports `connectBridge`, which the host app calls to register its
 * in-page sandbox with a running pyric bridge process. After
 * registration, MCP tool calls reaching the bridge are forwarded over
 * WebSocket and dispatched into the local sandbox.
 *
 * The Node-side server entry lives in `./server.ts`. Wire format
 * shared by both lives in `./protocol.ts`.
 */

export type {
  BridgeMode,
  BridgeMessage,
  HelloFromClient,
  HelloFromBridge,
  ToolCallRequest,
  ToolCallResponse,
} from './protocol.js';
export {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_SANDBOX_PATH,
} from './protocol.js';

export { connectBridge } from './client/bridge.js';
export type {
  ConnectBridgeOptions,
  ConnectedBridge,
  SandboxToolDispatcher,
} from './client/bridge.js';
