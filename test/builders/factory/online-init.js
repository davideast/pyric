// A page init script (`context.addInitScript({ path })`). Chromium in a
// sandbox sees only a loopback interface and says it is offline, which a real
// user's browser never does; Studio then disables sign-in.
Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true });
