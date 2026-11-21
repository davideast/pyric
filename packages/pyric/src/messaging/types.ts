/** Public option types for `pyric/messaging` and `pyric/messaging/sw` mirroring `@firebase/messaging`. */
export interface RegisterOptions {
  /** Optional VAPID key. */
  vapidKey?: string;
  /** Optional service worker registration. */
  serviceWorkerRegistration?: ServiceWorkerRegistration;
}
