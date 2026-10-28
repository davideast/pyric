// Preloaded into the production AI mode dev server with NODE_OPTIONS=--import.
// It stands in for the network beneath pyric's guard. The guard wraps the
// global fetch dispatcher it finds, so every fetch the guard permits reaches
// this one, which names the host and refuses it. Loopback requests pass, and
// no request reaches the internet.
const DISPATCHER_PREFIX = "undici.globalDispatcher.";
new Headers(); // Loads undici, which installs its default agent in the slot.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

for (const slot of Object.getOwnPropertySymbols(globalThis)) {
  if (!Symbol.keyFor(slot)?.startsWith(DISPATCHER_PREFIX)) continue;
  const real = globalThis[slot];
  if (!real || typeof real.dispatch !== "function") continue;
  globalThis[slot] = new Proxy(real, {
    get(target, prop) {
      if (prop === "dispatch") {
        return function refuseOutbound(opts, handler) {
          const host = new URL(String(opts.origin)).hostname;
          if (LOOPBACK.has(host)) return real.dispatch(opts, handler);
          process.stderr.write(`[egress stand-in] refused fetch to ${host}\n`);
          throw new Error(`egress stand-in refused ${host}`);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
