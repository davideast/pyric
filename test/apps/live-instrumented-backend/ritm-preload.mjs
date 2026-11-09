// OpenTelemetry's CommonJS instrumentation hook (`require-in-the-middle`),
// loaded via `--import ./ritm-preload.mjs` alongside `@pyric/live/register`.
import Hook from "require-in-the-middle";

const hooked = [];
globalThis[Symbol.for("live.instrumented.ritm")] = hooked;

new Hook((exports, name) => {
  hooked.push(name);
  return exports;
});
