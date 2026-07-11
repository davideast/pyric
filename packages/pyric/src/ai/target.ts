/**
 * Dispatch routing for `pyric/ai` — the house dual-target pattern
 * (`pyric/auth` / `pyric/firestore`): every {@link AI} handle carries a
 * hidden {@link Target} discriminator via {@link TARGET_SYMBOL}; free
 * functions read it through {@link targetOf} and switch on `target.kind`.
 *
 * Sandbox-side state is the per-handle {@link AiBroker} (engine + event
 * emission); prod-side state lives on the installed `firebase/ai` `AI`
 * instance itself — the prod handle IS the upstream instance, stamped with
 * the brand so `ai.app === app` pass-through holds.
 */

import type { Sandbox } from 'pyric/sandbox';
import type { FirebaseApp } from 'firebase/app';
import type * as fbai from 'firebase/ai';

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

/** An instance of the AI mirror. Sandbox handles have no `app`. */
export interface AI {
  app?: FirebaseApp;
  backend: Backend;
  options?: AIOptions;
}

/** Sandbox dispatch target — carries the per-handle broker. */
export interface SandboxTarget {
  kind: 'sandbox';
  sandbox: Sandbox;
  broker: AiBroker;
}

/** Prod dispatch target — wraps the installed `firebase/ai` AI instance. */
export interface ProdTarget {
  kind: 'prod';
  ai: fbai.AI;
}

export type Target = SandboxTarget | ProdTarget;

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
 * `onCurrentUserChanged` and `withAuth`, which a `FirebaseApp` never has
 * (same structural sniff as `pyric/auth`).
 */
export function isSandbox(target: Sandbox | FirebaseApp): target is Sandbox {
  return (
    typeof target === 'object'
    && target !== null
    && typeof (target as Sandbox).onCurrentUserChanged === 'function'
    && typeof (target as Sandbox).withAuth === 'function'
  );
}
