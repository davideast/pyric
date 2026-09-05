/**
 * `@pyric/cli/bridge` — browser-side entry.
 *
 * Resolved by the `browser` condition in `package.json`'s exports map.
 * Exports `connectBridge`, which the host app calls to register its
 * in-page sandbox with a running pyric bridge process. After
 * registration, MCP tool calls reaching the bridge are forwarded over
 * WebSocket and dispatched into the local sandbox.
 *
 * The Node-side server entry lives in `./server.ts`. Wire format
 * shared by both lives in `./protocol.ts`.
 *
 * ALSO reachable as `@pyric/cli/bridge/client` — an explicit, condition-free
 * subpath for browser apps whose TYPE resolution doesn't apply the `browser`
 * condition (Pyric Studio's `moduleResolution: bundler` tsconfig resolves the
 * `./bridge` subpath's top-level `types` to the SERVER entry). Same file,
 * same surface.
 */

export type {
  AuthLens,
  BridgeMessage,
  ConsumerPresenceFrame,
  HelloFromClient,
  HelloFromBridge,
  RemoteConsumerRecord,
  RemoteSetLensFrame,
  RemoteSetLensAckFrame,
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
  ConnectedBridgeState,
  SandboxToolDispatcher,
  WorkerRelay,
} from './client/bridge.js';

// Re-anchor a served bridge URL to the page's own origin. The served app page
// and Pyric Studio both do this before connecting as the bridge peer (see
// `serve/entries/bridge-url.ts` for why the baked host can be the wrong
// machine). Pure + browser-safe; exported here so Studio reuses it verbatim.
export { toPageOriginWsUrl } from '../serve/entries/bridge-url.js';
