/**
 * The child's side of its IPC channel to the host.
 *
 * Every send passes a callback. Without one, `process.send()` on a channel
 * that has closed emits 'error' on the next tick; with an uncaughtException
 * handler installed (the child has one for onRequest sources), that error
 * runs the handler, which reports it by sending again. The result is a
 * next-tick loop that never yields to the event loop, so no timer and no
 * signal handler runs and the process spins until SIGKILL. A send from code
 * that finishes after the host left (a trigger completing during shutdown)
 * is enough to start it.
 */

/** The part of `process` the channel functions use, so tests can pass a stand-in. */
export interface HostChannel {
  readonly connected: boolean;
  send?(message: unknown, callback: (error: Error | null) => void): boolean;
  disconnect?(): void;
}

/** Send to the host if the channel is open; a send that fails is dropped, never emitted. */
export function sendToHost(message: unknown, channel: HostChannel = process): void {
  if (!channel.connected || !channel.send) return;
  channel.send(message, (error) => {
    // The channel closed between the check and the write. The disconnect
    // handler ends this process; nothing here may emit.
    void error;
  });
}

/** Close the channel if it is still open; disconnecting a closed channel emits 'error'. */
export function disconnectFromHost(channel: HostChannel = process): void {
  if (channel.connected) channel.disconnect?.();
}
