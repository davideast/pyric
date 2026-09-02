import type { ToolHandler } from '@inbrowser/agent';

interface CanIUseResultLike {
  match: 'exact' | 'ambiguous' | 'suggestions' | 'none';
  supports: readonly { summary: string }[];
}

export interface CanIUseToolOptions<R extends CanIUseResultLike> {
  description: string;
  featureDescription: string;
  importPathDescription: string;
  query: (feature: string, options: { importPath?: string }) => R;
}

function resultSummary(result: CanIUseResultLike): string {
  if (result.match === 'none') return 'No conformance feature matched that query';
  if (result.match === 'suggestions') return `No exact match; found ${result.supports.length} deterministic suggestions`;
  if (result.match === 'ambiguous') return `Found ${result.supports.length} exact matches across surfaces`;
  return result.supports[0]!.summary;
}

/** The one authored pyric_can_i_use handler shape. Node and browser agents
 * differ only in the query they pass in, so match semantics, argument
 * validation, and summaries cannot drift between surfaces. */
export function createCanIUseTool<R extends CanIUseResultLike>(options: CanIUseToolOptions<R>): ToolHandler {
  return {
    name: 'pyric_can_i_use',
    description: options.description,
    parameters: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: options.featureDescription },
        importPath: { type: 'string', description: options.importPathDescription },
      },
      required: ['feature'],
    },
    async execute(args) {
      const { feature, importPath } = args as { feature?: unknown; importPath?: unknown };
      if (typeof feature !== 'string' || feature.trim() === '') {
        return { ok: false, summary: 'pyric can_i_use requires a non-empty feature name' };
      }
      if (importPath !== undefined && (typeof importPath !== 'string' || importPath.trim() === '')) {
        return { ok: false, summary: 'pyric can_i_use importPath must be a non-empty string when provided' };
      }
      const result = options.query(feature, {
        importPath: typeof importPath === 'string' ? importPath : undefined,
      });
      return { ok: result.match === 'exact', summary: resultSummary(result), data: result };
    },
  };
}
