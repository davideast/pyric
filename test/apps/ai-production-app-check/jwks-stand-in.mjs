// Preloaded into verify.mjs with NODE_OPTIONS=--import, before the register.
// It stands in for the network beneath firebase-admin: `https.request` to
// Firebase's App Check public keys (https://firebaseappcheck.googleapis.com/v1/jwks)
// is answered from the file JWKS_FILE names, and every other request that
// leaves loopback, through `http`, `https` or fetch, is refused and logged.
// The register, pyric-admin, firebase-admin and jwks-rsa all run unchanged.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const JWKS_HOST = "firebaseappcheck.googleapis.com";
const JWKS_PATH = "/v1/jwks";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const record = { served: [], refused: [] };
globalThis[Symbol.for("pyric.scenario.jwksStandIn")] = record;

function target(args) {
  const [first, second] = args;
  const options = typeof first === "string" || first instanceof URL ? { ...(typeof second === "object" ? second : {}), ...urlParts(first) } : first ?? {};
  return { host: options.hostname ?? options.host ?? "localhost", path: options.path ?? "/" };
}

function urlParts(url) {
  const parsed = new URL(String(url));
  return { hostname: parsed.hostname, path: parsed.pathname + parsed.search };
}

function callbackOf(args) {
  return args.find((arg) => typeof arg === "function");
}

/** A ClientRequest that answers with `body`, or fails with `error`, without opening a socket. */
function fakeRequest(callback, outcome) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => request;
  request.write = () => true;
  request.end = () => {
    process.nextTick(() => {
      if (outcome.error) return request.emit("error", outcome.error);
      const response = Readable.from([outcome.body]);
      response.statusCode = 200;
      response.statusMessage = "OK";
      response.headers = { "content-type": "application/json" };
      callback?.(response);
    });
    return request;
  };
  return request;
}

function standIn(module, scheme) {
  const real = module.request;
  module.request = function request(...args) {
    const { host, path } = target(args);
    if (LOOPBACK.has(host)) return real.apply(this, args);
    const isJwks = scheme === "https" && host === JWKS_HOST && path === JWKS_PATH;
    if (isJwks) {
      record.served.push(`${host}${path}`);
      process.stderr.write(`[jwks stand-in] served ${host}${path}\n`);
      return fakeRequest(callbackOf(args), { body: readFileSync(process.env.JWKS_FILE, "utf8") });
    }
    record.refused.push(`${host}${path}`);
    process.stderr.write(`[jwks stand-in] refused ${scheme} request to ${host}${path}\n`);
    return fakeRequest(callbackOf(args), { error: new Error(`jwks stand-in refused ${host}`) });
  };
  module.get = function get(...args) {
    const request = module.request(...args);
    request.end();
    return request;
  };
}

standIn(http, "http");
standIn(https, "https");

// fetch: the same refusal, beneath the guard, as vite-ssr-client-sdk/egress-stand-in.mjs does it.
const DISPATCHER_PREFIX = "undici.globalDispatcher.";
new Headers(); // Loads undici, which installs its default agent in the slot.
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
          record.refused.push(`${host}${opts.path ?? ""}`);
          process.stderr.write(`[jwks stand-in] refused fetch to ${host}\n`);
          throw new Error(`jwks stand-in refused ${host}`);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
