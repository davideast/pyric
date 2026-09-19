import { connectBridge } from '@pyric/cli/bridge/client';
import { initializeSandbox } from 'pyric/sandbox';

const button = document.createElement('button');
button.id = 'reject-peer';
button.textContent = 'Open oversized peer';
const output = document.createElement('output');
output.id = 'peer-state';
output.textContent = 'Idle';
document.body.append(button, output);

button.addEventListener('click', () => {
  const sandbox = initializeSandbox();
  const peer = connectBridge(sandbox, {
    url: `${location.origin.replace('http:', 'ws:')}/__pyric/sandbox`,
    sandboxId: 'é'.repeat(6 * 1024 * 1024),
    noReconnect: true,
    onStateChange(state) { output.textContent = state.kind; },
  });
  window.addEventListener('pagehide', () => {
    peer.disconnect();
    sandbox.dispose();
  }, { once: true });
});
