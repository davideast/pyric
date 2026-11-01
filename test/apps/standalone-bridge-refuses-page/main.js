import { initializeSandbox } from "pyric/sandbox";
import { connectBridge } from "@pyric/cli/bridge/client";

// App code that registers its in-page sandbox with a standalone
// `pyric bridge`, the way the bridge client's docs used to describe.
// Resolves with every state the client went through once it settles.
window.attachToBridge = (url) =>
  new Promise((resolve) => {
    const states = [];
    let bridge;
    const settle = () => {
      resolve({ states, final: bridge.state() });
      bridge.disconnect();
    };
    bridge = connectBridge(initializeSandbox(), {
      url,
      initialReconnectDelayMs: 100,
      onStateChange: (state) => {
        states.push(state);
        if (state.kind === "connected" || state.kind === "disconnected") setTimeout(settle, 500);
      },
    });
  });
