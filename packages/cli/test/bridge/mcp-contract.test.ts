/**
 * The two contracts: the six service tools `pyric mcp` advertises, and the
 * transport surface a browser sandbox peer executes underneath them.
 */
import { describe, expect, it } from 'bun:test';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';
import {
  BRIDGE_FORWARDED_TOOL_NAMES,
  BRIDGE_IN_PROCESS_TOOL_NAMES,
  DEFAULT_MCP_TOOL_NAMES,
  getBridgeToolSurface,
} from '../../src/bridge/server/mcp-contract.js';
import { TOOLS } from '../../src/bridge/surface/methods/registry.js';
import { renderSurface } from '../../src/bridge/surface/index.js';

/** The methods each service tool carries, in the order its directory lists them. */
const SERVICE_METHODS: Readonly<Record<string, string[]>> = {
  firestore: [
    'addDoc',
    'deleteDoc',
    'getDoc',
    'getDocs',
    'setDoc',
    'updateDoc',
    'writeBatch',
  ],
  database: ['get', 'query', 'remove', 'set', 'update'],
  storage: ['deleteObject', 'getBytes', 'getMetadata', 'listAll', 'uploadBytes'],
  auth: [
    'actAsAdmin',
    'actAsAnonymous',
    'createUser',
    'deleteUser',
    'getUser',
    'impersonate',
    'listUsers',
    'setCustomUserClaims',
    'updateUser',
    'useAppSession',
    'whoami',
  ],
  rules: ['explainDenial', 'getStdlib', 'lint', 'listStdlib', 'set', 'simulate'],
  sandbox: [
    'apply',
    'checkpoint',
    'deleteCheckpoint',
    'diff',
    'discard',
    'events',
    'exportFixture',
    'fork',
    'inspect',
    'listBranches',
    'listCheckpoints',
    'promote',
    'reset',
    'restore',
    'seed',
    'seedFromFixture',
  ],
};

describe('the product MCP tool contract', () => {
  it('ratifies the exact public tools/list surface', () => {
    expect(DEFAULT_MCP_TOOL_NAMES).toEqual([
      'firestore',
      'database',
      'storage',
      'auth',
      'rules',
      'sandbox',
    ]);
  });

  it('is what a server with no surface flag renders', () => {
    expect(renderSurface(undefined).tools.map((tool) => tool.name)).toEqual([
      ...DEFAULT_MCP_TOOL_NAMES,
    ]);
  });

  it('pins the methods behind each service tool', () => {
    for (const tool of TOOLS) {
      expect(tool.methods.map((method) => method.method)).toEqual(SERVICE_METHODS[tool.name]!);
    }
  });

  it('advertises describe on every tool alongside its methods', () => {
    for (const tool of renderSurface(undefined).tools) {
      const schema = tool.inputSchema as {
        properties: { method: { enum: string[] } };
      };
      expect(schema.properties.method.enum).toEqual([
        ...SERVICE_METHODS[tool.name]!,
        'describe',
      ]);
    }
  });
});

describe('the bridge transport contract', () => {
  it('matches the browser dispatcher and live in-process handlers exactly', () => {
    const surface = getBridgeToolSurface();
    expect(surface.forwarded.map((tool) => tool.name).sort()).toEqual(
      [...BRIDGE_FORWARDED_TOOL_NAMES].sort(),
    );
    expect([...SANDBOX_TOOL_NAMES].sort()).toEqual([...BRIDGE_FORWARDED_TOOL_NAMES].sort());
    expect(surface.inProcess.map((tool) => tool.name).sort()).toEqual(
      [...BRIDGE_IN_PROCESS_TOOL_NAMES].sort(),
    );
  });

  it('carries the sandbox tools the service methods dispatch onto', () => {
    const transport = new Set([...BRIDGE_FORWARDED_TOOL_NAMES, ...BRIDGE_IN_PROCESS_TOOL_NAMES]);
    for (const name of [
      'firestore_get_document',
      'firestore_list_documents',
      'firestore_create_document',
      'firestore_update_document',
      'firestore_delete_document',
      'firestore_query_where',
      'firestore_add_document',
      'firestore_batch_write',
      'auth_create_user',
      'auth_get_user',
      'auth_list_users',
      'auth_update_user',
      'auth_delete_user',
      'auth_set_claims',
      'sandbox_inspect',
      'rtdb_simulate_access',
      'firestore_lint_rules',
      'firestore_simulate_rules',
      'firestore_rules_stdlib_list',
      'firestore_rules_stdlib_get',
    ]) {
      expect(transport.has(name)).toBe(true);
    }
  });
});
