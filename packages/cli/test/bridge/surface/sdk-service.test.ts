/**
 * The `sdk-service` variant: its coverage of the canonical operation set, the
 * thin top-level schema every tool advertises, the messages its validator
 * returns, a round trip against a real sandbox, and the `schemaRejected` mark a
 * rejected call carries through the surface server.
 *
 * The validator cases assert whole messages rather than a substring, because
 * the message is the product here: this variant deliberately gives the client's
 * schema checker almost nothing to check, and what it says when a call is wrong
 * is the only thing an agent has to correct itself with.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

import { createLocalBridge } from '../../../src/bridge/server/local-bridge.js';
import { registerRenderedSurface } from '../../../src/bridge/server/surface-server.js';
import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import { TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import { operationIds } from '../../../src/bridge/surface/method-types.js';
import type { BridgeToolEvent } from '../../../src/bridge/server/bridge.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';
import { CANONICAL_OPERATION_IDS } from '../../../src/bridge/surface/render/canonical-dispatch.js';

const TOOL_NAMES = ['firestore', 'database', 'storage', 'auth', 'rules', 'sandbox', 'assurance'];

const surface = renderSurface('sdk-service');

/** Call one tool of the variant against a fresh sandbox context. */
function callWith(ctx: SurfaceContext) {
  return async (
    tool: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<OperationResult> => {
    const rendered = surface.tools.find((candidate) => candidate.name === tool);
    if (!rendered) throw new Error(`no rendered tool named ${tool}`);
    return rendered.execute({ method, args }, ctx);
  };
}

/** Run one call against a throwaway sandbox, for the rejection cases. */
const call = callWith(createSurfaceContext(initializeSandbox()));

describe('the sdk-service tool set', () => {
  it('renders one tool per service', () => {
    expect(surface.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it('reaches every canonical operation through at least one method', () => {
    const reached = TOOLS.flatMap((tool) =>
      tool.methods.flatMap((method) => [...operationIds(method)]),
    );
    expect(new Set(reached).size).toBe(CANONICAL_OPERATION_IDS.length);
    expect([...new Set(reached)].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it('reaches switch_auth_identity through the four identity methods, distinguished by the action', () => {
    const authTool = TOOLS.find((tool) => tool.name === 'auth');
    const identityMethods = (authTool?.methods ?? []).filter((method) =>
      operationIds(method).includes('switch_auth_identity'),
    );
    expect(identityMethods.map((method) => method.method).sort()).toEqual(
      ['actAsAdmin', 'actAsAnonymous', 'impersonate', 'useAppSession'].sort(),
    );
  });

  it('gives every tool the same two top-level properties, args optional', () => {
    for (const tool of surface.tools) {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties)).toEqual(['method', 'args']);
      expect(schema.required).toEqual(['method']);
      expect(schema.properties.args).toEqual({
        type: 'object',
        additionalProperties: true,
        description: schema.properties.args.description as string,
      });
      const spec = TOOLS.find((candidate) => candidate.name === tool.name);
      expect(schema.properties.method.enum).toEqual([
        ...(spec?.methods ?? []).map((method) => method.method),
        'describe',
      ]);
    }
  });

  it('keeps every description under the sixteen hundred character limit', () => {
    for (const tool of surface.tools) {
      expect(tool.description.length).toBeLessThan(1600);
    }
  });

  it('resolves a call to its canonical operation and the method as the action', () => {
    expect(surface.resolve('firestore', { method: 'setDoc', args: { path: 'users/alice' } })).toEqual(
      { operation: 'write_firestore_document', action: 'setDoc' },
    );
    expect(surface.resolve('rules', { method: 'lint', args: { service: 'storage' } })).toEqual({
      operation: 'lint_storage_rules',
      action: 'lint',
    });
  });

  it('separates a plain listing from a constrained query on getDocs', () => {
    const listing = surface.resolve('firestore', { method: 'getDocs', args: { path: 'users' } });
    const query = surface.resolve('firestore', {
      method: 'getDocs',
      args: { path: 'users', constraints: [{ type: 'limit', value: 5 }] },
    });
    expect(listing.operation).toBe('list_firestore_documents');
    expect(query.operation).toBe('query_firestore_documents');
  });

  it('resolves describe to no operation', () => {
    expect(surface.resolve('firestore', { method: 'describe', args: { method: 'setDoc' } })).toEqual(
      { operation: null, action: 'describe' },
    );
  });
});

describe('the sdk-service validator', () => {
  it('names the closest method when the method does not exist', async () => {
    const result = await call('firestore', 'setDocument', { path: 'users/alice' });
    expect(result.summary).toBe(
      "firestore.setDocument: no method 'setDocument'. Did you mean 'setDoc'? The firestore tool accepts addDoc, deleteDoc, getDoc, getDocs, setDoc, updateDoc, writeBatch, describe. Call firestore with method 'setDoc'.",
    );
    expect(result.data).toEqual({
      code: 'invalid_arguments',
      tool: 'firestore',
      method: 'setDocument',
      field: 'method',
      fix: "Call firestore with method 'setDoc'.",
    });
  });

  it('refuses a collection path where a document path belongs', async () => {
    const result = await call('firestore', 'setDoc', { path: 'users', data: { role: 'admin' } });
    expect(result.summary).toBe(
      "firestore.setDoc: 'users' is a collection path, not a document path. A document path has an even number of segments, so setDoc needs a document id after the collection. Pass path as 'users/<documentId>'.",
    );
  });

  it('refuses a document path where a collection path belongs', async () => {
    const result = await call('firestore', 'addDoc', {
      path: 'users/alice',
      data: { role: 'admin' },
    });
    expect(result.summary).toBe(
      "firestore.addDoc: 'users/alice' is a document path, not a collection path. A collection path has an odd number of segments, so addDoc takes the collection without the document id. Pass path as 'users'.",
    );
  });

  it('renames claims to the Admin SDK customClaims', async () => {
    const result = await call('auth', 'setCustomUserClaims', {
      uid: 'alice',
      claims: { role: 'admin' },
    });
    expect(result.summary).toBe(
      "auth.setCustomUserClaims: unknown argument 'claims'. The SDK names this argument 'customClaims'. Pass 'customClaims' instead of 'claims'.",
    );
    expect((result.data as { field: string }).field).toBe('claims');
  });

  it('requires an explicit confirmation to reset', async () => {
    const result = await call('sandbox', 'reset', {});
    expect(result.summary).toBe(
      'sandbox.reset: Discard everything, or one service. Pass confirm: true to proceed.',
    );
  });

  it('refuses a database path holding a forbidden key character', async () => {
    const result = await call('database', 'set', { path: 'rooms/lobby.name', value: 1 });
    expect(result.summary).toBe(
      "database.set: path 'rooms/lobby.name' contains '.'. Realtime Database keys cannot contain '.', '#', '$', '[', ']', so set rejects the reference. Remove '.' from the path, or encode it.",
    );
  });

  it('refuses a payload that is not base64', async () => {
    const result = await call('storage', 'uploadBytes', {
      path: 'uploads/hello.txt',
      contentBase64: 'not base64!!',
    });
    expect(result.summary).toBe(
      "storage.uploadBytes: contentBase64 'not base64!!' is not base64. uploadBytes carries the object bytes base64 encoded, because a tool call is JSON. Pass contentBase64 as the payload, base64 encoded.",
    );
  });

  it('refuses an email that is not an address', async () => {
    const result = await call('auth', 'createUser', { uid: 'alice', email: 'alice' });
    expect(result.summary).toBe(
      "auth.createUser: email 'alice' is not an email address. Firebase Authentication requires a local part, an '@', and a domain. Pass an address such as 'alice@example.com'.",
    );
  });

  it('refuses a password below the six character minimum', async () => {
    const result = await call('auth', 'createUser', { uid: 'alice', password: 'abc12' });
    expect(result.summary).toBe(
      "auth.createUser: password 'abc12' is 5 characters. Firebase Authentication requires at least 6. Pass a password of 6 characters or more.",
    );
  });

  it('refuses a service that has no Security Rules', async () => {
    const result = await call('rules', 'lint', { service: 'firestone' });
    expect(result.summary).toBe(
      "rules.lint: argument 'service' is 'firestone', which is not one of firestore, database, storage. The SDK signature is lint(service: firestore|database|storage, rules?). Pass 'service' as 'firestore'.",
    );
  });

  it('names the whole set when no allowed value is close to the one passed', async () => {
    const result = await call('rules', 'lint', { service: 'zzzzzzzzzz' });
    expect(result.summary).toContain('Pass \'service\' as one of firestore, database, storage.');
  });

  it('refuses a query whose first ordering does not match its inequality', async () => {
    const result = await call('firestore', 'getDocs', {
      path: 'users',
      constraints: [
        { type: 'where', field: 'age', op: '>', value: 21 },
        { type: 'orderBy', field: 'name' },
      ],
    });
    expect(result.summary).toBe(
      "firestore.getDocs: an inequality filter on 'age' with the first orderBy on 'name'. Firestore requires the first orderBy field to match the inequality field. Pass orderBy 'age' first, then 'name'.",
    );
  });

  it('refuses an operator outside the SDK set', async () => {
    const result = await call('firestore', 'getDocs', {
      path: 'users',
      constraints: [{ type: 'where', field: 'role', op: '=', value: 'admin' }],
    });
    expect(result.summary).toBe(
      "firestore.getDocs: constraint 0 uses operator '='. The SDK operators are <, <=, ==, !=, >=, >, in, not-in, array-contains, array-contains-any. Use '==' for an equality filter, or another operator from that list.",
    );
  });

  it('refuses an explainDenial for a service with no trace', async () => {
    const result = await call('rules', 'explainDenial', {
      service: 'storage',
      operation: 'get',
      path: 'uploads/hello.txt',
    });
    expect(result.summary).toBe(
      "rules.explainDenial: service 'storage' has no denial trace. explainDenial reads the Firestore rules engine only in this build. Pass service 'firestore', or call simulate for storage.",
    );
  });

  it('renames a seed users entry tenant to the Admin SDK tenantId', async () => {
    const result = await call('sandbox', 'seed', {
      users: [{ uid: 'alice', tenant: 'tenant-acme' }],
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      "sandbox.seed: users entry has unknown field 'tenant'. seed names this field 'tenantId'. Pass 'tenantId' instead of 'tenant' in the users entry.",
    );
  });

  it('renames a seed users entry claims to the Admin SDK customClaims', async () => {
    const result = await call('sandbox', 'seed', {
      users: [{ uid: 'alice', claims: { role: 'admin' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      "sandbox.seed: users entry has unknown field 'claims'. seed names this field 'customClaims'. Pass 'customClaims' instead of 'claims' in the users entry.",
    );
  });
});

describe('the sandbox seed vocabulary', () => {
  it('stores tenantId and customClaims from a seed users entry', async () => {
    const sandbox = initializeSandbox();
    const run = callWith(createSurfaceContext(sandbox));
    const result = await run('sandbox', 'seed', {
      users: [{ uid: 'alice', tenantId: 'tenant-acme', customClaims: { role: 'admin' } }],
    });
    expect(result.ok).toBe(true);

    const auth = getAuth(sandbox);
    const [stored] = authSandbox.exportUsers(auth);
    expect(stored?.tenantId).toBe('tenant-acme');
    expect(stored?.customClaims).toEqual({ role: 'admin' });
  });
});

describe('optional args', () => {
  it('accepts a call with no args to a no-argument method', async () => {
    const sandbox = initializeSandbox();
    const rendered = surface.tools.find((candidate) => candidate.name === 'storage');
    if (!rendered) throw new Error('no rendered tool named storage');
    const result = await rendered.execute({ method: 'listAll' }, createSurfaceContext(sandbox));
    expect(result.ok).toBe(true);
  });

  it('gives the missing-field message, not a schema dump, when args is omitted for a required argument', async () => {
    const sandbox = initializeSandbox();
    const rendered = surface.tools.find((candidate) => candidate.name === 'firestore');
    if (!rendered) throw new Error('no rendered tool named firestore');
    const result = await rendered.execute({ method: 'getDoc' }, createSurfaceContext(sandbox));
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      "firestore.getDoc: argument 'path' is missing. The SDK signature is getDoc(path). " +
        "Pass 'path'. Document path, for example users/alice.",
    );
  });
});

describe('describe', () => {
  it('returns a schema and an example for every method of every tool', async () => {
    for (const spec of TOOLS) {
      for (const method of spec.methods) {
        const result = await call(spec.name, 'describe', { method: method.method });
        expect(result.ok).toBe(true);
        const data = result.data as {
          signature: string;
          inputSchema: { type: string };
          example: { method: string; args: Record<string, unknown> };
          operations: string[];
        };
        expect(data.signature).toBe(method.signature);
        expect(data.inputSchema.type).toBe('object');
        expect(data.example.method).toBe(method.method);
        expect(data.operations).toEqual([...operationIds(method)]);
      }
    }
  });

  it('refuses a describe that names no method', async () => {
    const result = await call('sandbox', 'describe', {});
    expect(result.summary).toBe(
      "sandbox.describe: args.method is missing. describe reads one method schema, so it names the method to read. Pass args: { method: 'apply' }.",
    );
  });
});

describe('a round trip against a real sandbox', () => {
  it('writes a document with setDoc and reads it back with getDoc', async () => {
    const run = callWith(createSurfaceContext(initializeSandbox()));
    const written = await run('firestore', 'setDoc', {
      path: 'rooms/lobby',
      data: { topic: 'welcome', members: 2 },
    });
    expect(written.ok).toBe(true);

    const read = await run('firestore', 'getDoc', { path: 'rooms/lobby' });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.data)).toContain('welcome');

    const listed = await run('firestore', 'getDocs', { path: 'rooms' });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.data)).toContain('lobby');
  });
});

describe('a rejected call over a real MCP session', () => {
  it('records an invalid-arguments result as a schema rejection', async () => {
    const sandbox = initializeSandbox();
    const events: BridgeToolEvent[] = [];
    const bridge = createLocalBridge(sandbox, { onToolEvent: (event) => events.push(event) });
    const server = new McpServer({ name: 'pyric', version: bridge.version });
    registerRenderedSurface(
      server,
      bridge,
      renderSurface('sdk-service'),
      createSurfaceContext(sandbox),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'sdk-service-test', version: '0' });
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      const rejected = await client.callTool({
        name: 'firestore',
        arguments: { method: 'setDoc', args: { path: 'users', data: { role: 'admin' } } },
      });
      expect(rejected.isError).toBeTruthy();

      const accepted = await client.callTool({
        name: 'firestore',
        arguments: { method: 'setDoc', args: { path: 'users/alice', data: { role: 'admin' } } },
      });
      expect(accepted.isError).toBeFalsy();

      expect(events.map((event) => event.schemaRejected)).toEqual([true, false]);
      expect(events.map((event) => event.operation)).toEqual([
        'write_firestore_document',
        'write_firestore_document',
      ]);
      expect(events.map((event) => event.action)).toEqual(['setDoc', 'setDoc']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
