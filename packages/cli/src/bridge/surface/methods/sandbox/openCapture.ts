import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { runCaptureMethod } from '../../../../serve/rate-capture-service.js';
import { formatWrongFileError, identifyPyricFile } from '../../../../verify/file-format.js';
import { projectPathWithin } from '../../arguments/sandbox.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

const CAPTURE_ID_PATTERN = /^[0-9a-f-]{36}$/;
const MAX_INSPECT_BYTES = 32 * 1024 * 1024;

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isWithinRealProject(projectDir: string, filePath: string): boolean {
  try {
    const realRoot = realpathSync(projectDir);
    const realTarget = realpathSync(filePath);
    return realTarget === realRoot || realTarget.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

function inspectWrongCaptureFile(projectDir: string, filePath: string): string | null {
  let raw: string;
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INSPECT_BYTES) return null;
    if (!isWithinRealProject(projectDir, filePath)) return null;
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const detected = identifyPyricFile(parsed);
  if (detected === null) return null;
  if (detected.kind !== 'rate-capture') {
    return formatWrongFileError('rate-capture', parsed);
  }
  return "pyric sandbox openCapture takes a saved capture id rather than a file path. Save it with 'pyric sandbox saveCapture' or omit 'id' to open the latest saved capture.";
}

export default {
  tool: 'sandbox',
  method: 'openCapture',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'openCapture(id?)',
  description: 'Inspect rate capture.',
  args: z.object({
    id: z
      .string()
      .optional()
      .describe('Capture id. Omit to open the latest saved capture. Read-only; does not restore or replay.'),
  }),
  operation: 'open_rate_capture',
  example: {},
  async handler(args, ctx) {
    let givenId: string | undefined;
    if (typeof args.id === 'string') {
      givenId = args.id;
    }
    if (givenId !== undefined && !CAPTURE_ID_PATTERN.test(givenId)) {
      const resolved = projectPathWithin(
        ctx.projectDir,
        givenId,
        'id',
        failFor('sandbox', 'openCapture'),
      );
      if ('path' in resolved) {
        const wrongFile = inspectWrongCaptureFile(ctx.projectDir, resolved.path);
        if (wrongFile !== null) return operationFailure(wrongFile);
      }
      return operationFailure(
        `Invalid capture id '${givenId}'. ${formatWrongFileError('rate-capture', null)}`,
      );
    }
    try {
      return await runCaptureMethod('openCapture', args, ctx.projectDir);
    } catch (error) {
      if (givenId !== undefined && CAPTURE_ID_PATTERN.test(givenId)) {
        const candidatePath = join(ctx.projectDir, '.pyric', 'captures', `${givenId}.json`);
        const wrongFile = inspectWrongCaptureFile(ctx.projectDir, candidatePath);
        if (wrongFile !== null) return operationFailure(wrongFile);
      }
      return operationFailure(errorMessageOf(error));
    }
  },
} satisfies MethodRecord;
