/**
 * `firebase/functions` under the served sandbox: connects the page runtime as
 * the sandbox peer and routes callable requests to Pyric's gateway across
 * sandbox and production AI modes.
 */
import './init.js';
import './runtime.js';
export * from './functions-surface.js';
