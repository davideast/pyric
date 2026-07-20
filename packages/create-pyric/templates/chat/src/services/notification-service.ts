import { getMessaging, getToken, isSupported, onMessage, type GetTokenOptions, type Messaging, type MessagePayload } from 'firebase/messaging';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db, firebaseApp } from '../firebase/app';
import { type NotificationMessage, ServiceError } from '../firebase/types';
import { showPersistentNotification } from './notification-display';
import { requestNotificationPermission } from './notification-permission';
import messagingWorkerUrl from '../firebase-messaging-sw.ts?worker&url';

// Optional in the sandbox (the local broker mints tokens without it); required
// against production Firebase Cloud Messaging.
const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;

const toMessage = (payload: MessagePayload): NotificationMessage => ({
  title: payload.notification?.title ?? 'PyChat',
  body: payload.notification?.body ?? null,
  data: payload.data ?? {},
});

export class NotificationService {
  private messaging: Messaging | null = null;
  private foregroundRegistered = false;
  private onForeground: ((message: NotificationMessage) => void) | null = null;
  private displayRegistration: ServiceWorkerRegistration | null = null;

  private async nativeDisplayRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (this.displayRegistration) return this.displayRegistration;
    if (!('serviceWorker' in navigator)) return null;

    this.displayRegistration = await navigator.serviceWorker.register(
      messagingWorkerUrl,
      { type: 'module' },
    );
    await navigator.serviceWorker.ready;
    return this.displayRegistration;
  }

  private async showNative(message: NotificationMessage): Promise<void> {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const options: NotificationOptions = {
      body: message.body ?? undefined,
      tag: message.data.conversationId ?? 'pychat',
    };
    const registration = await this.nativeDisplayRegistration();
    await showPersistentNotification(registration, message.title, options);
  }

  private async tokenOptions(): Promise<GetTokenOptions | undefined> {
    const options: GetTokenOptions = {};
    if (vapidKey) options.vapidKey = vapidKey;
    options.serviceWorkerRegistration = await this.nativeDisplayRegistration() ?? undefined;

    return Object.keys(options).length > 0 ? options : undefined;
  }

  private async handle(): Promise<Messaging | null> {
    if (this.messaging) return this.messaging;
    if (!(await isSupported())) return null;
    this.messaging = getMessaging(firebaseApp);
    return this.messaging;
  }

  /**
   * Request notification permission, register for a token, and forward every
   * foreground message to `onForeground`. Returns the registration token, or
   * `null` when the browser cannot receive messages / permission was denied.
   * The same calls run unchanged against production Firebase Cloud Messaging.
   */
  async enable(onForeground: (message: NotificationMessage) => void): Promise<string | null> {
    const messaging = await this.handle();
    if (!messaging) return null;
    if (!(await requestNotificationPermission())) return null;
    try {
      this.onForeground = onForeground;
      const token = await getToken(messaging, await this.tokenOptions());
      const uid = auth.currentUser?.uid;
      // Persist the token so the notify trigger can read it via the admin SDK.
      if (uid) await setDoc(doc(db, 'users', uid), { fcmToken: token }, { merge: true });
      if (!this.foregroundRegistered) {
        onMessage(messaging, (payload) => this.onForeground?.(toMessage(payload)));
        this.foregroundRegistered = true;
      }
      return token;
    } catch (error) {
      throw new ServiceError('network', 'Could not register for notifications', error);
    }
  }

  async showEnabledConfirmation(): Promise<void> {
    await this.showNative({
      title: 'PyChat notifications enabled',
      body: 'Minimize PyChat to receive assistant reply alerts.',
      data: { conversationId: 'pychat-enabled' },
    });
  }
}
