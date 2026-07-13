/** Public value types for the sandbox app composition root. */
import type { Sandbox } from '../sandbox/types/service.js';
import type { SandboxApp } from '../sandbox/internal/app-handle.js';

export type { SandboxApp } from '../sandbox/internal/app-handle.js';

export type PyricAppTarget = 'sandbox';
export type PyricApp = SandboxApp;

/** Direct Pyric initialization always requires an explicit sandbox. */
export type InitializeAppConfig = { sandbox: Sandbox };
