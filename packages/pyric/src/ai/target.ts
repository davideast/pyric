/**
 * Sandbox routing for `pyric/ai`: every {@link AI} handle carries its broker
 * and sandbox behind {@link TARGET_SYMBOL}. Production selection belongs to
 * package resolution and never enters this module.
 */

import type { Sandbox } from 'pyric/sandbox';
import type { PyricApp } from 'pyric/app';

import type { AiBroker, AnswerEngine, EngineConfig } from './broker/index.js';
import type { Backend } from './backend.js';

export const TARGET_SYMBOL: unique symbol = Symbol('pyric/ai/target');

/** Initialization options; `engine` is the sandbox-only answer-engine seam. */
export interface AIOptions {
  backend?: Backend;
  useLimitedUseAppCheckTokens?: boolean;
  /** Sandbox targets only: engine config (`scripted` default) or a custom engine. */
  engine?: EngineConfig | AnswerEngine;
}

/** An instance of the AI mirror. Direct sandbox handles have no `app`. */
export interface AI {
  app?: PyricApp;
  backend: Backend;
  options?: AIOptions;
}

/** Sandbox dispatch target — carries the per-handle broker. */
export interface SandboxTarget {
  kind: 'sandbox';
  sandbox: Sandbox;
  broker: AiBroker;
}

export type Target = SandboxTarget;

/**
 * Recover the dispatch target for an {@link AI} handle. Throws if the handle
 * wasn't produced by this package — the brand is the only way in.
 */
export function targetOf(ai: AI): Target {
  const target = (ai as { [TARGET_SYMBOL]?: Target })[TARGET_SYMBOL];
  if (!target) {
    throw new TypeError('pyric/ai: unrecognized AI handle — was it produced by getAI(...)?');
  }
  return target;
}

/**
 * Brand-based discriminator for `getAI`: a {@link Sandbox} carries
 * `onCurrentUserChanged` and `withAuth`, which a {@link PyricApp} wrapper
 * never has.
 */
export function isSandbox(target: Sandbox | PyricApp): target is Sandbox {
  return (
    typeof target === 'object'
    && target !== null
    && typeof (target as Sandbox).onCurrentUserChanged === 'function'
    && typeof (target as Sandbox).withAuth === 'function'
  );
}
