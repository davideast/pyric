import React, { useEffect, useRef, useState } from 'react';
import { notificationStartup } from './notification-startup';
import workerUrl from './firebase-messaging-sw.ts?worker&url';

type TestState = { phase: 'idle' | 'running' } | { phase: 'finished'; message: string };

/** Exercise the device's display API independently of message delivery. */
export function NotificationDisplayTest() {
  const [state, setState] = useState<TestState>({ phase: 'idle' });
  const attempt = useRef<ReturnType<typeof notificationStartup> | undefined>(undefined);
  useEffect(() => () => {
    attempt.current?.cancel();
    attempt.current = undefined;
  }, []);
  const run = async () => {
    if (attempt.current) return;
    const startup = notificationStartup(() => {});
    attempt.current = startup;
    setState({ phase: 'running' });
    let message: string;
    try {
      const registration = await startup.run('finding the notification worker', () => navigator.serviceWorker.getRegistration(workerUrl));
      const hasActiveWorker = registration?.active !== undefined && registration.active !== null;
      if (!hasActiveWorker) throw new Error('Enable notifications first, then run the device test.');
      const options = {
        body: 'This notification tests your device display directly.',
        tag: 'orbit-device-display-test',
        renotify: true,
        data: { channel: 'design' },
      };
      await startup.run('displaying the device notification', () => registration.showNotification('Orbit device notification test', options));
      message = 'Browser accepted the notification. Check your device’s notifications.';
    } catch (error) {
      message = error instanceof Error ? error.message : 'The device notification test failed. Try again.';
    } finally {
      startup.finish();
    }
    const isCurrentAttempt = attempt.current === startup;
    if (!isCurrentAttempt) return;
    attempt.current = undefined;
    setState({ phase: 'finished', message });
  };
  const running = state.phase === 'running';
  return <div className="notification-display-test">
    <button className="notification-enable" disabled={running} onClick={() => void run()}>
      {running ? 'Testing…' : 'Test device notification'}
    </button>
    {state.phase === 'finished' && <p role="status">{state.message}</p>}
  </div>;
}
