// The backend's request instrumentation, installed the two ways APM agents
// install it, as INSTRUMENT names: "assign" replaces https.request by
// assignment, as a hand-written wrapper does; "define" replaces it with
// Object.defineProperty and keeps the original on the wrapper, as shimmer
// (OpenTelemetry's HTTP instrumentation, many APM agents) does. Either wrapper
// counts each request and passes it through unchanged.
import https from "node:https";

export const instrumented = { mode: process.env.INSTRUMENT, requests: 0 };

const original = https.request;

function wrappedRequest(...args) {
  instrumented.requests += 1;
  return original.apply(this, args);
}

if (instrumented.mode === "define") {
  const descriptor = Object.getOwnPropertyDescriptor(https, "request");
  Object.defineProperty(wrappedRequest, "__original", { value: original, configurable: true, writable: true });
  Object.defineProperty(wrappedRequest, "__wrapped", { value: true, configurable: true, writable: true });
  Object.defineProperty(https, "request", { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value: wrappedRequest });
} else {
  https.request = wrappedRequest;
}
