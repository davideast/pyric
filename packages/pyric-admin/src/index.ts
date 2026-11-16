/**
 * Root `pyric-admin` entry point -- pure re-export barrel.
 *
 * Exposes the root admin facade and modular app exports, including the
 * `module.exports` binding so CommonJS `require('firebase-admin')` receives
 * the live `admin` facade directly.
 */
export * from './app/index.js';
export * from './admin.js';
export { default, default as 'module.exports' } from './admin.js';
