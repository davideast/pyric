/**
 * The JSON files the hourly check reads back, each with its schema. Every
 * read goes through `readRunFile` (no link, no FIFO, a size limit) and the
 * schema, whether the file is in the run's host directory or, like a walk
 * result, in a sandbox's root.
 */
import { z } from 'zod';
import { parseJsonText, parseWith } from '../parse.ts';
import { readRunFile, replaceFile } from './host-files.ts';

export class StateFileError extends Error {}

/** Reads `path` through `schema`; undefined when it doesn't exist, an error when it is anything but valid. */
export function readJson<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | undefined {
  const read = readRunFile(path);
  if (!read.ok && read.problem.includes('ENOENT')) return undefined;
  if (!read.ok) throw new StateFileError(`${path} can't be read: ${read.problem}`);
  const text = parseJsonText(read.text);
  const parsed = text.ok ? parseWith(schema, text.value) : text;
  if (!parsed.ok) throw new StateFileError(`${path}: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

/** Writes `value` through a fresh sibling and a rename. */
export function writeJson(path: string, value: unknown): void {
  replaceFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const layoutFinding = z.object({
  rule: z.enum(['horizontal-scroll', 'overlap', 'clipped-text', 'column-misaligned']),
  key: z.string(),
  detail: z.string(),
}).strict();

/** A screenshot's name: one file in the capture folder, no directory. */
const screenshotName = z.string().regex(/^[\w.-]+\.png$/);

export const pageCaptureSchema = z.object({
  path: z.string(),
  width: z.number().int().positive(),
  screenshot: screenshotName,
  findings: z.array(layoutFinding),
  error: z.string().optional(),
}).strict();

export const walkResultSchema = z.object({
  walks: z.array(z.object({ name: z.string(), passed: z.boolean(), error: z.string().optional(), visited: z.array(z.string()) }).strict()),
  pages: z.array(pageCaptureSchema),
}).strict();

export const captureRecordSchema = z.object({
  commit: z.string(),
  capturedAt: z.string().datetime(),
  widths: z.array(z.number().int().positive()),
  notes: z.array(z.string()).optional(),
}).strict();

export type CaptureRecord = z.infer<typeof captureRecordSchema>;

export const knownFailuresSchema = z.record(z.record(z.number().int().positive()));

export const baselineStateSchema = z.object({
  startCommit: z.string(),
  walksHash: z.string(),
  capturedAt: z.string().datetime(),
  knownFailures: knownFailuresSchema,
  error: z.string().optional(),
}).strict();
