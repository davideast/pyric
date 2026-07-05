import { DataHandler } from './handler.js';
import type { RtdbHost } from '../host.js';
import type { RtdbTools } from '../types.js';
import type { StructureNode } from '../crawl/spec.js';
import type { ValidatedWriteInput, ValidatedWriteResult, SchemaWarning } from './spec.js';
import type { UserAuth } from '../types.js';

const WRITE_OP_MAP = { set: 'set', update: 'update', push: 'push' } as const;

function findNode(node: StructureNode, targetPath: string): StructureNode | null {
  if (node.path === targetPath) return node;
  for (const child of node.children) {
    const found = findNode(child, targetPath);
    if (found) return found;
  }
  return null;
}

function validateSchema(
  data: unknown,
  schema: Record<string, string>,
): SchemaWarning[] {
  if (typeof data !== 'object' || data === null) return [];
  const warnings: SchemaWarning[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const actualType = value === null ? 'null' : typeof value;
    if (key in schema) {
      if (schema[key] !== actualType) {
        warnings.push({ field: key, issue: 'type_mismatch', expected: schema[key], actual: actualType });
      }
    } else {
      warnings.push({ field: key, issue: 'new_field', actual: actualType });
    }
  }
  return warnings;
}

export class ValidatedWriteHandler {
  private dataHandler = new DataHandler();

  async execute(
    host: RtdbHost,
    db: RtdbTools,
    input: ValidatedWriteInput,
  ): Promise<ValidatedWriteResult> {
    try {
      // 1. Infer schema at target path
      let schemaWarnings: SchemaWarning[] = [];
      const crawlResult = await db.crawlStructure({ path: '/', maxDepth: 10 });
      if (crawlResult.success) {
        const node = findNode(crawlResult.data, input.path);
        if (node && Object.keys(node.schema).length > 0) {
          schemaWarnings = validateSchema(input.data, node.schema);
        }
      }

      // 2. Simulate security rules
      // Note: simulation uses empty mockData, so cross-path rule lookups
      // (e.g., root.child("team-members").child(auth.uid).exists()) will
      // evaluate as false. When user auth is provided, the live write
      // enforces real rules — simulation is advisory only in that case.
      let simulationResult: { allowed: boolean; matchedRule: string } | null = null;
      const simResult = db.simulate({
        operation: 'write',
        path: input.path,
        auth: input.auth,
        mockData: {},
        newData: input.data,
      });

      if (simResult.success) {
        simulationResult = { allowed: simResult.data.allowed, matchedRule: simResult.data.matchedRule };
        // Only block on simulation denial when NOT using user auth (admin mode).
        // In user mode, the live write enforces real rules against the actual database.
        if (!simResult.data.allowed && !input.auth) {
          return {
            success: false,
            error: {
              code: 'SIMULATION_DENIED',
              message: `Security rules deny write at ${input.path}: ${simResult.data.reason}`,
              recoverable: true,
            },
          };
        }
      }
      // If simulation fails (e.g., IR not generated), proceed without it

      // 3. Execute the write (respect user auth if provided)
      const writeResult = await this.dataHandler.execute(
        host,
        WRITE_OP_MAP[input.operation],
        input.path,
        input.data,
        input.auth ? input.auth as UserAuth : undefined,
      );

      if (!writeResult.success) {
        return {
          success: false,
          error: writeResult.error,
        };
      }

      return {
        success: true,
        data: writeResult.data,
        schemaWarnings,
        simulationResult,
      };
    } catch (e) {
      return {
        success: false,
        error: {
          code: 'WRITE_FAILED',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
  }
}
