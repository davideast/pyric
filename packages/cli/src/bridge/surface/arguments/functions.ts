/**
 * The `functions` tool's argument vocabulary.
 *
 * `fire` names a discovered trigger by its export name and a concrete Realtime
 * Database path; the params a wildcard segment captures come from matching
 * that path against the trigger's own reference pattern rather than being
 * spelled by the caller a second time.
 */
import { z } from 'zod';

export const triggerArgument = z
  .string()
  .describe("The trigger's export name, as listTriggers names it.");

export const pathArgument = z
  .string()
  .describe('Root-relative Realtime Database path the event is synthesized at.');

export const valueArgument = z
  .unknown()
  .describe('The value the synthetic event carries at path. Never written to the database.');
