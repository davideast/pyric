/** Cancel abandoned setup without allowing its late results to publish a token. */
export function notificationStartup(onStage: (stage: string) => void) {
  const controller = new AbortController();
  let stage = 'starting';
  const timer = setTimeout(() => controller.abort(
    new Error(`Notification setup timed out while ${stage}. Check the connection and try again.`),
  ), 10_000);
  return {
    cancel() {
      controller.abort(new Error('Notification setup cancelled.'));
      clearTimeout(timer);
    },
    finish() { clearTimeout(timer); },
    async run<T>(nextStage: string, action: () => Promise<T>): Promise<T> {
      const { signal } = controller;
      signal.throwIfAborted();
      stage = nextStage;
      onStage(stage);
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return action();
        }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    },
  };
}
