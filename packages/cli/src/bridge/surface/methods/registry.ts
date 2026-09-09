/**
 * The loaded surface: seven service tools and the methods behind them, and the
 * lookups every derived surface joins on.
 *
 * The list is not authored here. `scripts/generate-surface-manifest.ts` reads the `tools`
 * and `methods` directories and renders `../manifest.generated.ts`; this loader
 * stamps each record with the key its path carries and refuses a record whose
 * own `tool` and `method` disagree with where it lives, because a record that
 * says one thing and is filed under another would be reachable under two names
 * and auditable under neither.
 */
import { METHOD_RECORDS, TOOL_RECORDS } from '../manifest.generated.js';
import { operationIds, type Method, type Tool } from '../method-types.js';

/** Methods of one tool, in the order the manifest lists them. */
function methodsOf(tool: string): Method[] {
  const loaded: Method[] = [];
  for (const [owner, name, record] of METHOD_RECORDS) {
    if (owner !== tool) continue;
    if (record.tool !== owner) {
      throw new Error(
        `method record methods/${owner}/${name}.ts declares tool '${record.tool}'`,
      );
    }
    if (record.method !== name) {
      throw new Error(
        `method record methods/${owner}/${name}.ts declares method '${record.method}'`,
      );
    }
    loaded.push({ ...record, key: `${owner}.${name}` });
  }
  return loaded;
}

function loadTools(): readonly Tool[] {
  const loaded = TOOL_RECORDS.map(([name, record]) => ({
    ...record,
    name,
    methods: methodsOf(name),
  }));
  const orders = new Set<number>();
  for (const tool of loaded) {
    if (orders.has(tool.order)) throw new Error(`duplicate tool order ${tool.order}`);
    orders.add(tool.order);
    if (tool.methods.length === 0) throw new Error(`tool '${tool.name}' has no methods`);
  }
  return [...loaded].sort((a, b) => a.order - b.order);
}

/** Every service tool, in `tools/list` order. */
export const TOOLS: readonly Tool[] = loadTools();

/** Every method of every tool, in tool order then manifest order. */
export const METHODS: readonly Method[] = TOOLS.flatMap((tool) => tool.methods);

/** Every method by `<tool>.<method>`. */
export const METHODS_BY_KEY: ReadonlyMap<string, Method> = new Map(
  METHODS.map((method) => [method.key, method]),
);

/** One tool by name, or undefined when the name is not one of ours. */
export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** One method of one tool by name. `describe` is not one of these. */
export function methodByName(tool: Tool, name: string): Method | undefined {
  return tool.methods.find((method) => method.method === name);
}

/** One method by `<tool>.<method>`. Throws when the key is not one of ours. */
export function methodByKey(key: string): Method {
  const method = METHODS_BY_KEY.get(key);
  if (method === undefined) throw new Error(`unknown surface method '${key}'`);
  return method;
}

/** Every canonical operation the records reach, sorted. */
export const CANONICAL_OPERATIONS: readonly string[] = [
  ...new Set(METHODS.flatMap((method) => operationIds(method))),
].sort();
