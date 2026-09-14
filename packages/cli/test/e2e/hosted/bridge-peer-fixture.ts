import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { connectBridge } from '../../../src/bridge/client/bridge.js';

type ConnectedPeer = { client: Client; sandbox: LocalSandbox };

/** Keep a public sandbox peer and MCP caller connected for a wire-level scenario. */
export async function withBridgePeer(
  socketUrl: string,
  mcpUrl: string,
  run: (peer: ConnectedPeer) => Promise<void>,
): Promise<void> {
  const sandbox = initializeSandbox();
  let connected = false;
  const peer = connectBridge(sandbox, {
    url: socketUrl, noReconnect: true,
    onStateChange: state => { connected = state.kind === 'connected'; },
  });
  const client = new Client({ name: 'peer-fixture', version: '1' });
  try {
    await expect.poll(() => connected).toBe(true);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    await run({ client, sandbox });
  } finally {
    peer.disconnect();
    await client.close();
  }
}
