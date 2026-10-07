/**
 * The RTDB rules standard library: constraint builders, grouped in modules,
 * that compile to Realtime Database rule expressions.
 *
 * It is the counterpart of the Firestore and Storage rules standard library.
 * Those modules are rules source imported under `rules_version = '2+modules'`;
 * RTDB rules have no functions, so each RTDB module is a TypeScript namespace
 * whose builders return the whole expression for a `.write` or `.validate`
 * rule, ready to compose with `all`, `any` and `not` in `defineRtdbRules`.
 * The catalog in `./catalog.ts` describes each builder for the
 * `rules_stdlib_list` and `rules_stdlib_get` tools.
 */
import * as validation from './validation.js';
import * as lifecycle from './lifecycle.js';
import * as lobby from './lobby.js';
import * as turns from './turns.js';
import * as results from './results.js';
import * as counters from './counters.js';
import * as presence from './presence.js';
import * as timing from './timing.js';
import * as collections from './collections.js';

export const rtdbStdlib = Object.freeze({
  validation,
  lifecycle,
  lobby,
  turns,
  results,
  counters,
  presence,
  timing,
  collections,
});

export type RtdbStdlib = typeof rtdbStdlib;
export type { FieldRule, ShapeOptions, ShapeResult } from './validation.js';
