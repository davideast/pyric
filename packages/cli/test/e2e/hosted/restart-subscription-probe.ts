import { getHostedFirestore } from '../../../src/serve/worker/client/websocket-connection.js';
import { subscribeEvents } from '../../../src/serve/worker/client/studio.js';
import { subscribePresence } from '../../../src/serve/worker/client/presence.js';

const init = await fetch('/__pyric/init.json').then(response => response.json());
const endpoint = new URL(init.bridgeUrl, location.href);
endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const db = getHostedFirestore({ url: endpoint.href, projectKey: init.projectKey });
const presence = document.querySelector('#presence')!;
const events = document.querySelector('#events')!;
subscribePresence(db, snapshot => { presence.textContent = JSON.stringify(snapshot.clients); });
subscribeEvents(db, batch => {
  for (const event of batch) events.textContent += JSON.stringify(event) + '\n';
});
