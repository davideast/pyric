/**
 * Node-side composition of the MCP tools the bridge serves.
 *
 * Each tool record folds into one MCP tool: a description that lists every
 * operation with its fields, and one input schema whose required `op` enum
 * selects the operation and whose remaining properties are the union of the
 * operations' fields. Every operation keeps its own schema, so a call is
 * validated against exactly the fields of the operation it names.
 *
 * Forwarded operations are executed by the browser sandbox peer, so this
 * process never holds a `LocalEnvironment`; their factories run with a stub
 * resolver and only metadata is read. In-process operations run here and are
 * composed as live handlers.
 */

import type { ToolHandler } from '@inbrowser/agent';
import { z } from 'zod';
import {
  bindOpArgs,
  resolveOpHandlers,
  toolOps,
  toolRecords,
  type ToolOp,
  type ToolTransport,
} from '../tool-records.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import {
  FORWARDED_FACTORIES,
  IN_PROCESS_FACTORIES,
  type InProcessContext,
  type StubResolver,
} from './tool-factories.js';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  [key: string]: unknown;
}

/** One field of one operation, as listed in the tool description and in validation errors. */
export interface OpField {
  name: string;
  required: boolean;
  type?: string;
  description?: string;
}

export interface OpIssue {
  /** Dotted field path, or `''` for the whole argument object. */
  field: string;
  message: string;
}

export interface ToolResultLike {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface McpToolOp {
  readonly tool: string;
  readonly op: string;
  readonly transport: ToolTransport;
  readonly handler: string;
  readonly description: string;
  /** Input schema of this operation: the handler's schema minus pinned fields. */
  readonly parameters: JsonSchema;
  readonly fields: readonly OpField[];
  /** Validates the caller's fields (without `op`). Returns the issues, or `null` when valid. */
  validate(args: Record<string, unknown>): OpIssue[] | null;
  /** In-process operations only: runs the handler with pinned fields applied. */
  readonly execute?: (args: Record<string, unknown>) => Promise<ToolResultLike>;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** Advertised input schema: required `op` enum plus the union of the operations' fields. */
  readonly parameters: JsonSchema;
  readonly ops: readonly McpToolOp[];
}

const OP_FIELD_DESCRIPTION =
  'Operation to run. Each op accepts only the fields listed for it in the tool description.';
const VARIES_BY_OP = 'Depends on op; see the operation list in the tool description.';

function opSchema(handler: ToolHandler, spec: ToolOp): JsonSchema {
  const source = handler.parameters as JsonSchema;
  const pinned = new Set(Object.keys(spec.fixed ?? {}));
  const properties: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(source.properties ?? {})) {
    if (name === 'op') {
      throw new Error(
        `handler '${handler.name}' declares a field named 'op', which the fold reserves`,
      );
    }
    if (!pinned.has(name)) properties[name] = schema;
  }
  const required = (source.required ?? []).filter((name) => !pinned.has(name));
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function schemaType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type[0];
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.enum)) return 'enum';
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return 'union';
  return undefined;
}

function opFields(schema: JsonSchema): OpField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, field]) => ({
    name,
    required: required.has(name),
    ...(schemaType(field) ? { type: schemaType(field) } : {}),
    ...(field.description ? { description: field.description } : {}),
  }));
}

function withoutDescription(schema: JsonSchema): JsonSchema {
  const { description: _description, ...rest } = schema;
  return rest;
}

/**
 * One property for the advertised schema from the same-named field of
 * several operations. Identical schemas pass through; schemas that differ
 * only in description keep the structure and note that the meaning depends on
 * the op; structurally different schemas become an `anyOf`.
 */
function unionProperty(variants: readonly JsonSchema[]): JsonSchema {
  const byStructure = new Map<string, JsonSchema>();
  for (const variant of variants) {
    const key = JSON.stringify(withoutDescription(variant));
    if (!byStructure.has(key)) byStructure.set(key, variant);
  }
  const structures = [...byStructure.values()];
  if (structures.length > 1) {
    return { anyOf: structures.map(withoutDescription), description: VARIES_BY_OP };
  }
  const first = variants[0]!;
  const sameDescription = variants.every((variant) => variant.description === first.description);
  return sameDescription ? first : { ...withoutDescription(first), description: VARIES_BY_OP };
}

function unionSchema(ops: readonly McpToolOp[]): JsonSchema {
  const variants = new Map<string, JsonSchema[]>();
  for (const op of ops) {
    for (const [name, schema] of Object.entries(op.parameters.properties ?? {})) {
      const list = variants.get(name) ?? [];
      list.push(schema);
      variants.set(name, list);
    }
  }
  const properties: Record<string, JsonSchema> = {
    op: { type: 'string', enum: ops.map((op) => op.op), description: OP_FIELD_DESCRIPTION },
  };
  for (const [name, list] of variants) properties[name] = unionProperty(list);
  return { type: 'object', properties, required: ['op'] };
}

function fieldLine(field: OpField): string {
  const qualifiers = [field.type, field.required ? 'required' : undefined].filter(Boolean);
  const head = qualifiers.length > 0 ? `${field.name} (${qualifiers.join(', ')})` : field.name;
  return field.description ? `${head}: ${field.description}` : head;
}

function toolDescription(description: string, ops: readonly McpToolOp[]): string {
  const lines = [
    description,
    '',
    `Set "op" to one of: ${ops.map((op) => op.op).join(', ')}.`,
    '',
  ];
  for (const op of ops) {
    lines.push(`- ${op.op}: ${op.description}`);
    lines.push(
      op.fields.length > 0
        ? `  Fields: ${op.fields.map(fieldLine).join('; ')}`
        : '  Fields: none',
    );
  }
  return lines.join('\n');
}

function describeIssue(issue: z.ZodIssue, op: string): OpIssue {
  const field = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return {
      field,
      message: `${issue.keys.map((key) => `'${key}'`).join(', ')} ${issue.keys.length === 1 ? 'is not a field' : 'are not fields'} of op '${op}'`,
    };
  }
  if (issue.code === 'invalid_type' && issue.received === 'undefined') {
    return { field, message: `'${field}' is required` };
  }
  return { field, message: field ? `'${field}': ${issue.message}` : issue.message };
}

function composeOp(spec: ToolOp, handler: ToolHandler): McpToolOp {
  const parameters = opSchema(handler, spec);
  const validator = z.object(jsonSchemaToZodShape(parameters as never)).strict();
  const inProcess = spec.transport === 'in-process';
  return {
    tool: spec.tool,
    op: spec.op,
    transport: spec.transport,
    handler: handler.name,
    description: spec.description ?? handler.description,
    parameters,
    fields: opFields(parameters),
    validate(args) {
      const parsed = validator.safeParse(args);
      return parsed.success ? null : parsed.error.issues.map((issue) => describeIssue(issue, spec.op));
    },
    ...(inProcess
      ? {
          execute: async (args: Record<string, unknown>) => {
            // The bridge supplies a ToolContext without cancellation; handlers
            // that need one should honour a signal supplied by the transport.
            const ctx = { signal: new AbortController().signal } as never;
            const result = await handler.execute(bindOpArgs(spec, args), ctx);
            return { ok: result.ok, summary: result.summary, data: result.data };
          },
        }
      : {}),
  };
}

/**
 * The MCP tools of the default surface, in record order. Fails closed when a
 * record names a handler its factory does not yield. `context` carries what
 * the entry point resolved for the in-process factories, such as project
 * credentials; the tool list is the same with or without it.
 */
export function composeMcpTools(context: InProcessContext = {}): McpTool[] {
  const stub: StubResolver = () => {
    throw new Error(
      'BUG: sandbox-tool factory executor invoked on the bridge side — should have been replaced',
    );
  };
  const handlers = resolveOpHandlers(toolOps(), (spec) =>
    spec.transport === 'forwarded'
      ? FORWARDED_FACTORIES[spec.factory as keyof typeof FORWARDED_FACTORIES](stub)
      : IN_PROCESS_FACTORIES[spec.factory as keyof typeof IN_PROCESS_FACTORIES](context),
  );
  return toolRecords().map((record) => {
    const ops = Object.keys(record.ops).map((op) => {
      const entry = handlers.get(`${record.name}.${op}`)!;
      return composeOp(entry.spec, entry.handler);
    });
    return {
      name: record.name,
      description: toolDescription(record.description, ops),
      parameters: unionSchema(ops),
      ops,
    };
  });
}

export type ToolCallResolution =
  | { ok: true; op: McpToolOp; args: Record<string, unknown> }
  | { ok: false; op: string; result: ToolResultLike & { ok: false } };

/**
 * Select the operation a call names and validate its fields. An unknown op,
 * or fields the op does not accept, yields a structured error result that
 * names the valid ops and the fields of the attempted op.
 */
export function resolveToolCall(tool: McpTool, rawArgs: Record<string, unknown>): ToolCallResolution {
  const { op: opValue, ...fields } = rawArgs;
  const validOps = tool.ops.map((op) => op.op);
  const op = typeof opValue === 'string' ? tool.ops.find((candidate) => candidate.op === opValue) : undefined;
  if (!op) {
    const attempted = typeof opValue === 'string' ? opValue : '';
    return {
      ok: false,
      op: attempted,
      result: {
        ok: false,
        summary:
          (attempted
            ? `${tool.name}: unknown op '${attempted}'`
            : `${tool.name}: 'op' is required`) + `; valid ops: ${validOps.join(', ')}`,
        data: { error: 'unknown_op', tool: tool.name, op: attempted, validOps },
      },
    };
  }
  const issues = op.validate(fields);
  if (issues) {
    return {
      ok: false,
      op: op.op,
      result: {
        ok: false,
        summary: `${tool.name}.${op.op}: invalid fields: ${issues.map((issue) => issue.message).join('; ')}`,
        data: {
          error: 'invalid_fields',
          tool: tool.name,
          op: op.op,
          issues,
          fields: op.fields,
          validOps,
        },
      },
    };
  }
  return { ok: true, op, args: fields };
}
