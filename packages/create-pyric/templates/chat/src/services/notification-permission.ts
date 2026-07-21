type NotificationPermissionApi = Pick<typeof Notification, 'permission' | 'requestPermission'>;

/** Resolve whether this page may construct native OS notifications. */
export async function requestNotificationPermission(
  notificationApi: NotificationPermissionApi | undefined = globalThis.Notification,
): Promise<boolean> {
  if (!notificationApi || notificationApi.permission === 'denied') return false;
  if (notificationApi.permission === 'granted') return true;
  if (notificationApi.permission === 'default') {
    return (await notificationApi.requestPermission()) === 'granted';
  }
  return false;
}
