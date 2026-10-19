// Preloaded into the production AI mode dev server with NODE_OPTIONS=--import.
// It stands in for the network beneath pyric's guard. The guard wraps the
// global fetch dispatcher it finds, so every fetch the guard permits reaches
// this one, which names the host and refuses it. Loopback requests pass, and
// no request reaches the internet.
const DISPATCHER = Symbol.for("undici.globalDispatcher.1");
new Headers(); // Loads undici, which installs its default agent in the slot.
const real = globalThis[DISPATCHER];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function refuseOutbound(opts, handler) {
  const host = new URL(String(opts.origin)).hostname;
  if (LOOPBACK.has(host)) return real.dispatch(opts, handler);
  process.stderr.write(`[egress stand-in] refused fetch to ${host}\n`);
  throw new Error(`egress stand-in refused ${host}`);
}

globalThis[DISPATCHER] = new Proxy(real, {
  get(target, prop) {
    if (prop === "dispatch") return refuseOutbound;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
