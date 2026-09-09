/**
 * What a discriminator route is, and the four readings every route makes of a
 * call's arguments.
 *
 * A route is the whole mapping for one value of a tool's discriminator: which
 * operation runs, what the audit log stamps as the action, and how the tool's
 * arguments (JSON-encoded strings included) translate into the operation's
 * object parameters. The route blocks are grouped by the family they serve and
 * live in their own files; this is the vocabulary they share, so a family can
 * be read and changed without opening the others.
 */
import type { z } from 'zod';

export type Args = Record<string, unknown>;

/** One of the twelve tools, as the client sees it. */
export interface DiscriminatorTool {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
}

/** One discriminator value's route to a canonical operation. */
export interface DiscriminatorRoute {
  tool: string;
  /** The action the audit event records, or null for a tool with no discriminator. */
  action: string | null;
  /** Whether these arguments take this route. */
  selects(args: Args): boolean;
  operation: string;
  translate(args: Args): Args;
}

/** One argument's value when it is a string, and nothing when it is not. */
export function text(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parse a JSON-encoded object parameter back into the object it stands for. */
export function parseJsonObject(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  const parsed = JSON.parse(source) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Parse a JSON-encoded value parameter back into the value it stands for. */
export function parseJsonValue(source: string | undefined): unknown {
  if (source === undefined) return undefined;
  return JSON.parse(source) as unknown;
}

/** Parse a JSON-encoded array parameter back into the array it stands for. */
export function parseJsonArray(source: string | undefined): unknown[] | undefined {
  if (source === undefined) return undefined;
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
  return parsed;
}

/** Carry one value onto a translated call, leaving an absent one absent. */
export function assign(target: Args, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/** A route selected by one field's value. */
export function on(field: string, value: string): (args: Args) => boolean {
  return (args) => args[field] === value;
}

/** A route selected by two fields' values. */
export function onBoth(
  first: string,
  firstValue: string,
  second: string,
  secondValue: string,
): (args: Args) => boolean {
  return (args) => args[first] === firstValue && args[second] === secondValue;
}
