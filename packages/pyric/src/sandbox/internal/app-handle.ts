/**
 * Neutral sandbox-app handle shared by the app composition root and service
 * mirrors. Keeping this contract below both layers prevents a service from
 * depending upward on `pyric/app` merely to unwrap its sandbox.
 */
import type { Sandbox } from '../types/service.js';

export const APP_TARGET = Symbol.for('pyric.app.target');

export interface SandboxApp {
  readonly [APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  readonly name: string;
}

export function isSandboxApp(value: unknown): value is SandboxApp {
  return (
    typeof value === 'object'
    && value !== null
    && APP_TARGET in value
    && (value as SandboxApp)[APP_TARGET] === 'sandbox'
  );
}

let defaultAppResolver: (() => SandboxApp) | undefined;

/** Install the app composition root's default-registry lookup. */
export function installDefaultAppResolver(resolve: () => SandboxApp): void {
  defaultAppResolver = resolve;
}

/** Resolve the default sandbox app without importing the app composition root. */
export function getDefaultSandboxApp(): SandboxApp {
  if (!defaultAppResolver) {
    throw new TypeError(
      'No default sandbox app registry is installed - import and initialize pyric/app before calling a service factory without an app.',
    );
  }
  return defaultAppResolver();
}
