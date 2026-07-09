/**
 * Sandbox demo page — the capture demo (`app/main.ts`) with its imports
 * resolved to the pyric worker-backed messaging client INSTEAD of
 * `firebase/messaging`. No Google anywhere: the token, both delivery
 * routes, and the send plane are all the sandbox broker inside the served
 * SharedWorker (the pyric dev worker host).
 *
 * Same page contract as the capture app so the e2e driver reuses the rig
 * pattern: status line, token display, live log, two send buttons, and
 * every event reported over POST /capture. Differences, honestly:
 *   - no service-worker registration / notification permission — the
 *     sandbox has no push plane; `sw-registered`/`permission` captures are
 *     replaced by `worker-connected`.
 *   - the background route's handler is registered from THIS page over the
 *     port (`onBackgroundMessage`); the real SW file has no stand-in until
 *     `pyric dev` serves an in-page firebase/messaging mirror (the
 *     graduation wiring).
 *   - the send buttons drive the broker's send plane through the SAME
 *     worker port (`send`), replacing the harness's firebase-admin sends.
 *   - visibility crosses the transport: this page reports its REAL
 *     `document.visibilityState` now and on every visibilitychange, so a
 *     hidden tab marks its worker-side client not-visible (the captured
 *     routing rule). `__forceVisibility` exists as the documented
 *     automation fallback (headless tab activation is unreliable).
 * __DECOY__ is injected at build time by the e2e driver.
 */
import {
  getMessaging,
  getToken,
  deleteToken,
  onMessage,
  onBackgroundMessage,
  onError,
  send,
  setVisibility,
} from './messaging-client.js';

declare const __DECOY__: string;

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
  const messaging = getMessaging('/worker.js');
  onError(messaging, (e) => post('error', { message: e.message, code: e.code }));

  // Visibility wiring — the page's REAL visibility drives the worker-side
  // broker client (routing keys on visibility, never focus).
  const reportVisibility = async (forced?: 'visible' | 'hidden'): Promise<void> => {
    const state = forced ?? (document.visibilityState === 'visible' ? 'visible' : 'hidden');
    await setVisibility(messaging, state);
    post('visibility', { state, forced: forced !== undefined });
  };
  document.addEventListener('visibilitychange', () => void reportVisibility());
  await reportVisibility();
  post('worker-connected', {});
  el('status').textContent = 'sandbox worker connected';

  const token = await getToken(messaging, { vapidKey: 'unused-in-sandbox' });
  post('token', { token });
  el('status').textContent = 'token minted — listening';
  el('token').textContent = token;

  // Driver-facing command channel (rig parity — see app/main.ts).
  const w = window as unknown as {
    __getTokenAgain: () => Promise<string>;
    __deleteToken: () => Promise<boolean>;
    __forceVisibility: (state: 'visible' | 'hidden') => Promise<void>;
  };
  w.__getTokenAgain = () => getToken(messaging);
  w.__deleteToken = () => deleteToken(messaging);
  w.__forceVisibility = (state) => reportVisibility(state);

  onMessage(messaging, (payload) => {
    const meta = { visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
    post('onMessage', { payload, meta });
    logMessage('onMessage (foreground — the page handles it; no OS notification)', payload);
  });

  onBackgroundMessage(messaging, (payload) => {
    const meta = { visibilityState: document.visibilityState };
    post('onBackgroundMessage', { payload, meta });
    logMessage('onBackgroundMessage (broker background route — the SW path)', payload);
  });

  // The demo's send plane, through the same broker (tags let the driver wait
  // on the RIGHT capture; delay gives the background case time to hide).
  const sendDemo = (tag: string, delayMs: number): void => {
    setTimeout(() => {
      void send(messaging, {
        token,
        notification: { title: `oracle ${tag}`, body: `${tag} delivery capture` },
        data: { source: 'messaging-web-e2e', tag, demo: '1' },
      })
        .then((accepted) => post('send-accepted', { tag, name: accepted.name }))
        .catch((e) => post('error', { message: String(e), tag }));
    }, delayMs);
  };

  el('send-fg').onclick = () => sendDemo('foreground', 0);
  el('send-bg').onclick = () => {
    el('status').textContent = 'sending in 4s — a decoy tab is hiding this page…';
    sendDemo('background', 4000);
    // Cross-origin decoy (different port): switching to it genuinely hides
    // this page without counting as a visible client of our origin.
    window.open(__DECOY__, '_blank');
  };

  post('listening', {});
}

main().catch((e) => post('error', { message: String(e), stack: (e as Error).stack }));
