import { deleteApp, initializeApp } from '/__pyric/sdk/app.js';
import {
  getMessaging,
  onBackgroundMessage,
} from '/__pyric/sdk/messaging-sw.js';

const app = initializeApp({ apiKey: 'demo', projectId: 'demo' });
const messaging = getMessaging(app);
const realmId = crypto.randomUUID();

onBackgroundMessage(messaging, async (payload) => {
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const window of windows) {
    window.postMessage({ type: 'pyric-background-message', payload });
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'pyric-messaging-ready') {
    event.ports[0]?.postMessage({ ready: true, realmId });
    return;
  }
  if (event.data?.type === 'pyric-messaging-cleanup') {
    void deleteApp(app).then(() => event.ports[0]?.postMessage({ cleaned: true }));
  }
});
