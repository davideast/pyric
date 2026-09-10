/** List the Security Rules standard library modules. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({});

export default {
  verb: 'list',
  service: 'rules',
  object: 'stdlib',
  description:
    'List every Security Rules standard library module as key, kind, and description. Read this before writing rules rather than inventing a function name.',
  parameters,
  async handler(_args, ctx) {
    return callSandboxTool(ctx, 'firestore_rules_stdlib_list', {});
  },
} satisfies OperationRecord;
