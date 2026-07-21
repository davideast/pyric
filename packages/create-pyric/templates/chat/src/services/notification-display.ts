type NotificationConstructor = new (title: string, options?: NotificationOptions) => Notification;
type NotificationRegistration = Pick<ServiceWorkerRegistration, 'showNotification'>;

/** Prefer the persistent service-worker display surface used by production FCM. */
export async function showPersistentNotification(
  registration: NotificationRegistration | null,
  title: string,
  options: NotificationOptions,
  fallback: NotificationConstructor | undefined = globalThis.Notification,
): Promise<void> {
  if (registration) {
    await registration.showNotification(title, options);
    return;
  }
  if (fallback) new fallback(title, options);
}
