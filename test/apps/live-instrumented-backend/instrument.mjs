// The backend's request instrumentation, as OpenTelemetry's HTTP
// instrumentation or an APM agent installs it: it replaces https.request with
// a wrapper that counts each request and passes it through unchanged.
import https from "node:https";

export const instrumented = { requests: 0 };

const original = https.request;
https.request = function wrappedRequest(...args) {
  instrumented.requests += 1;
  return original.apply(this, args);
};
