// The scenario's trap for every connection the guard lets out that the
// stand-in Agent does not carry: each host name lookup but loopback's fails
// here, before any socket opens, and the host is recorded. So a request the
// guard passes reaches no real host, and the backend can say which hosts
// the guard let out.
import dns from "node:dns";

export const trapped = [];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const original = dns.lookup;

dns.lookup = function trappedLookup(hostname, options, callback) {
  const done = typeof options === "function" ? options : callback;
  if (LOOPBACK.has(hostname)) return original.call(this, hostname, options, callback);
  trapped.push(hostname);
  const error = Object.assign(new Error(`scenario trap: ${hostname} never resolves`), { code: "SCENARIO_TRAP" });
  process.nextTick(() => done(error));
  return {};
};
