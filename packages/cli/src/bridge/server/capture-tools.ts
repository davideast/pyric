import rename from '../surface/methods/sandbox/renameCapture.js';
import remove from '../surface/methods/sandbox/deleteCapture.js';
import type { ToolHandler } from '@inbrowser/agent';
import save from '../surface/methods/sandbox/saveCapture.js';
import list from '../surface/methods/sandbox/listCaptures.js';
import open from '../surface/methods/sandbox/openCapture.js';
import { toJsonSchema } from '../surface/json-schema.js';
import { runCaptureMethod } from '../../serve/rate-capture-service.js';

/** File operations execute on the project host, never in the browser peer. */
export function createCaptureTools(projectDir = process.cwd()): ToolHandler[] {
  const entries = [
    {
      record: save, method: 'saveCapture',
      name: 'sandbox_save_capture',
    },
    {
      record: list, method: 'listCaptures',
      name: 'sandbox_list_captures',
    },
    {
      record: open, method: 'openCapture',
      name: 'sandbox_open_capture',
    },
    {
      record: rename, method: 'renameCapture',
      name: 'sandbox_rename_capture',
    },
    {
      record: remove, method: 'deleteCapture',
      name: 'sandbox_delete_capture',
    },
  ] as const;
  return entries.map(({ record, method, name }) => ({
    name,
    description: `${record.description} Stored in this project's .pyric/captures. Opening is read-only and never restores state or replays operations.`,
    parameters: toJsonSchema(record.args),
    async execute(args) {
      const parsed = record.args.parse(args);
      return runCaptureMethod(method, parsed, projectDir);
    },
  }));
}
