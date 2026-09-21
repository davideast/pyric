import React, { useEffect, useRef, useState } from 'react';
import { deleteToken, getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { ref, remove, set } from 'firebase/database';
import { auth, channels, rtdb } from './data';
import { NotificationDisplayTest } from './notification-display-test';
import { notificationStartup } from './notification-startup';
import workerUrl from './firebase-messaging-sw.ts?worker&url';

type Mention = { uid: string; channel: string; messageId: string; title: string; body: string };
function isMention(value: unknown): value is Mention {
  const isRecord = typeof value === 'object' && value !== null;
  if (!isRecord) return false;
  const fields = ['uid', 'channel', 'messageId', 'title', 'body'] as const;
  return fields.every(field => {
    const isStringField = field in value && typeof Reflect.get(value, field) === 'string';
    return isStringField;
  });
}

async function notificationPermission() {
  try { return (await navigator.permissions.query({ name: 'notifications' })).state; }
  catch { return Notification.permission; }
}

/** Wait for this registration, including production workers scoped under /assets/. */
async function waitForActivation(registration: ServiceWorkerRegistration) {
  if (registration.active) return;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Notification worker did not start. Try again.');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const activated = worker.state === 'activated';
      const failed = worker.state === 'redundant';
      if (activated) finish();
      if (failed) finish(new Error('Notification worker failed. Try again.'));
    };
    const timer = setTimeout(() => finish(new Error('Notification startup timed out. Try again.')), 10_000);
    worker.addEventListener('statechange', check);
    check();
  });
}

// Serialize token replacement so a departing session cannot revoke a new one's token.
let lifecycle = Promise.resolve();
let needsTokenRevocation = false;

async function revokePreviousToken() {
  if (!needsTokenRevocation) return;
  await deleteToken(getMessaging());
  needsTokenRevocation = false;
}

export function useNotifications(uid: string) {
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [status, setStatus] = useState('Notifications are off on this browser.');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const connect = useRef(async (_requestPermission = true) => {});
  const disconnect = useRef(async () => {});
  useEffect(() => {
    const preference = `orbit-notifications:${uid}`;
    let disposed = false;
    let tokenPath: string | undefined;
    let unsubscribe = () => {};
    let attempt: ReturnType<typeof notificationStartup> | undefined;
    let releaseTask: Promise<void> | undefined;
    const receive = (value: unknown) => {
      if (!isMention(value)) return;
      const belongsToSession = value.uid === uid && auth.currentUser?.uid === uid;
      const canReceive = belongsToSession && !disposed;
      if (!canReceive) return;
      setMentions(current => [value, ...current.filter(item => item.messageId !== value.messageId)].slice(0, 50));
    };
    const background = (event: MessageEvent) => {
      if (event.data?.type === 'orbit-mention') receive(event.data.data);
    };
    navigator.serviceWorker?.addEventListener('message', background);
    const stop = (removeOwnedRegistration = false) => {
      if (releaseTask) return releaseTask;
      disposed = true;
      const mayOwnToken = tokenPath !== undefined || localStorage.getItem(preference) === 'enabled';
      needsTokenRevocation ||= mayOwnToken;
      attempt?.cancel();
      unsubscribe();
      navigator.serviceWorker?.removeEventListener('message', background);
      const release = async () => {
        await revokePreviousToken();
        if (!tokenPath) return;
        // External identity switches have already changed the rules context.
        // Revoke the token; the backend prunes its obsolete mapping on send.
        const stillOwnsRegistration = removeOwnedRegistration && auth.currentUser?.uid === uid;
        if (stillOwnsRegistration) await remove(ref(rtdb, tokenPath));
        tokenPath = undefined;
      };
      releaseTask = lifecycle.then(release, release);
      lifecycle = releaseTask;
      return releaseTask;
    };
    disconnect.current = () => stop(true);
    connect.current = async (requestPermission = true) => {
      const cannotStart = disposed || attempt !== undefined;
      if (cannotStart) return;
      const startup = notificationStartup(stage => setStatus(`Enabling notifications: ${stage}…`));
      attempt = startup;
      setBusy(true);
      try {
        const supported = await startup.run('checking browser support', isSupported);
        if (!supported) throw new Error('Notifications need a supported browser and a secure connection.');
        const permission = await startup.run('waiting for browser permission', async () => {
          const current = await notificationPermission();
          const mayAsk = current === 'prompt' || current === 'default';
          const canPrompt = requestPermission && mayAsk;
          return canPrompt ? Notification.requestPermission() : current;
        });
        const permissionGranted = permission === 'granted';
        if (!permissionGranted) throw new Error('Notifications are blocked for this site or browser session. Use a regular browser window and allow notifications in this site’s permissions.');
        // Keep permission separate from registration: switching identities must
        // not erase the browser's choice, even if a later connection step fails.
        localStorage.setItem(preference, 'enabled');
        const register = async () => {
          const registration = await startup.run('registering the notification worker', () => navigator.serviceWorker.register(workerUrl, { type: 'module' }));
          await startup.run('activating the notification worker', () => waitForActivation(registration));
          const messaging = getMessaging();
          const token = await startup.run('requesting a notification token', () => getToken(messaging, { serviceWorkerRegistration: registration, vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY }));
          const device = localStorage.getItem('orbit-notification-device') ?? crypto.randomUUID();
          localStorage.setItem('orbit-notification-device', device);
          const registrationPath = `notificationTokens/${uid}/${device}`;
          tokenPath = registrationPath;
          await startup.run('saving the notification token', () => {
            const ownsRegistration = auth.currentUser?.uid === uid;
            if (!ownsRegistration) throw new Error('Your account changed. Enable notifications for the current account.');
            return set(ref(rtdb, registrationPath), token);
          });
          const ownsSession = !disposed && auth.currentUser?.uid === uid;
          if (!ownsSession) return;
          unsubscribe();
          unsubscribe = onMessage(messaging, payload => receive(payload.data));
          setEnabled(true);
          setStatus('Notifications enabled on this browser.');
        };
        // Retry failed revocation before issuing another token. Retain the
        // native promise as a barrier even if this attempt's UI times out.
        lifecycle = lifecycle.then(revokePreviousToken, revokePreviousToken);
        await startup.run('finishing the previous notification session', () => lifecycle);
        const registrationTask = register();
        lifecycle = registrationTask.catch(() => {});
        await registrationTask;
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : 'Could not enable notifications. Try again.');
      } finally {
        startup.finish();
        attempt = undefined;
        if (!disposed) setBusy(false);
      }
    };
    const optedIn = localStorage.getItem(preference) === 'enabled';
    if (optedIn) void connect.current(false);
    return () => { void stop().catch(error => console.warn('Notification cleanup failed.', error)); };
  }, [uid]);
  return {
    mentions, status, enabled, busy,
    enable: () => connect.current(),
    disconnect: () => disconnect.current(),
  };
}

export function Notifications({ state, onOpen }: {
  state: ReturnType<typeof useNotifications>;
  onOpen: (channel: string) => void;
}) {
  const empty = state.mentions.length === 0;
  return <section className="notifications-panel" aria-label="Mentions">
    <div className="rail-heading"><h2>Notifications</h2></div>
    <div className="notification-settings">
      <p role="status">{state.status}</p>
      {!state.enabled && <button className="notification-enable" disabled={state.busy} onClick={() => void state.enable()}>
        {state.busy ? 'Enabling…' : 'Enable notifications'}
      </button>}
      <NotificationDisplayTest />
      <p>Mention @alice, @david, or @marcus in a message to get their attention.</p>
    </div>
    <div className="notification-list" aria-live="polite">
      {empty && <p className="rail-intro">No mentions yet.</p>}
      {state.mentions.map(mention => <button className="notification-item" key={mention.messageId} onClick={() => onOpen(mention.channel)}>
        <strong>{mention.title}</strong>
        <span>{mention.body}</span>
        <small>#{channels.find(channel => channel.id === mention.channel)?.name ?? mention.channel}</small>
      </button>)}
    </div>
  </section>;
}
