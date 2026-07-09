/**
 * Capture + demo page. Real firebase/messaging, no Pyric anywhere:
 * registers the SW, requests permission, mints a token, and reports every
 * step plus each onMessage payload to the harness over POST /capture.
 * Also renders a live message log and two self-serve send buttons (the
 * harness exposes /send endpoints backed by firebase-admin), so a human
 * can feel the two delivery routes directly.
 * __CONFIG__ and __VAPID__ are injected at build time by the harness.
 */
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, deleteToken } from 'firebase/messaging';

declare const __CONFIG__: Record<string, string>;
declare const __VAPID__: string;

function post(kind: string, data: unknown): void {
  void fetch('/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, data }),
  });
}

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function logMessage(source: string, payload: unknown): void {
  const item = document.createElement('li');
  const at = new Date().toLocaleTimeString();
  item.innerHTML = `<b>${at} · ${source}</b><pre>${JSON.stringify(payload, null, 2)}</pre>`;
  el('log').prepend(item);
}

async function main(): Promise<void> {
  const app = initializeApp(__CONFIG__);
  const messaging = getMessaging(app);

  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;
  post('sw-registered', { scope: reg.scope });
  el('status').textContent = 'service worker registered';

  const permission = await Notification.requestPermission();
  post('permission', { state: permission });
  if (permission !== 'granted') {
    el('status').textContent = `notification permission: ${permission}`;
    return;
  }

  const mint = () => getToken(messaging, { vapidKey: __VAPID__, serviceWorkerRegistration: reg });
  const token = await mint();
  post('token', { token });
  el('status').textContent = 'token minted — listening';
  el('token').textContent = token;

  // Driver-facing command channel. The harness drives these over
  // page.evaluate to keep every SDK call inside the real page context (the
  // only place firebase/messaging behaves like a user's app):
  //   __getTokenAgain  re-calls getToken on the same registration (token
  //                    stability probe)
  //   __deleteToken    deletes the current token (deleteToken/UNREGISTERED
  //                    probe); resolves true on success
  const w = window as unknown as {
    __getTokenAgain: () => Promise<string>;
    __deleteToken: () => Promise<boolean>;
  };
  w.__getTokenAgain = () => mint();
  w.__deleteToken = () => deleteToken(messaging);

  onMessage(messaging, (payload) => {
    // Capture visibility+focus AT delivery: the routing contract keys on
    // document.visibilityState (not focus), so recording both proves a
    // visible-but-unfocused page still gets onMessage.
    const meta = { visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
    post('onMessage', { payload, meta });
    logMessage('onMessage (foreground — the page handles it; no OS notification)', payload);
  });

  el('send-fg').onclick = () => void fetch('/send/foreground', { method: 'POST' });
  el('send-bg').onclick = () => {
    el('status').textContent = 'sending in 4s — a decoy tab is hiding this page…';
    void fetch('/send/background', { method: 'POST' });
    // A CROSS-origin tab (different port): switching to it hides this page,
    // and being cross-origin it is not a visible client of our origin - so
    // routing reliably goes to the service worker. (Same-origin about:blank
    // fails: it counts as a visible client. OS minimize fails under
    // automation unless occlusion flags are restored. Captured 2026-07-09.)
    window.open('http://localhost:4874', '_blank');
  };

  // Messages the SW handled while this page was hidden: show them in the
  // log when we come back.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if ((e.data as { kind?: string })?.kind === 'bg-delivered') {
      logMessage('onBackgroundMessage (SW showed the OS notification)', (e.data as { payload: unknown }).payload);
    }
  });

  post('listening', {});
}

main().catch((e) => post('error', { message: String(e), stack: (e as Error).stack }));
