/**
 * The surfaces the evaluation compares: each renders the same records, and each
 * resolves back to the canonical operation vocabulary the audit log records.
 */
import { describe, expect, it } from 'bun:test';

import { renderSurface, SURFACE_VARIANT_IDS } from '../../../src/bridge/surface/index.js';
import { METHODS } from '../../../src/bridge/surface/methods/registry.js';
import { operationIds } from '../../../src/bridge/surface/method-types.js';
import { schemaDepth } from '../../../src/bridge/surface/json-schema.js';
import {
  DISCRIMINATOR_ROUTES,
  DISCRIMINATOR_TOOLS,
} from '../../../src/bridge/surface/render/discriminator-routes.js';
import { RESOURCE_ROUTES } from '../../../src/bridge/surface/render/discriminator-resources.js';
import { CANONICAL_OPERATION_IDS } from '../../../src/bridge/surface/render/canonical-dispatch.js';

const NAMED_VARIANTS = ['verb-prefixed', 'noun-prefixed', 'verb-suffixed'];

/** How deep a method's own arguments nest: two object levels below the root. */
const ARGUMENT_DEPTH = 2;

/**
 * How deep an authored campaign record nests. The assurance methods carry the
 * campaign document's own records rather than arguments of their own, and a
 * probe holds a mutation, which holds an operation, which holds a payload. The
 * alternative to spelling that shape is an untyped object, which is what left
 * the closed sets invisible until the first rejection.
 */
const AUTHORED_RECORD_DEPTH = 4;

/** The depth budget one rendered tool is held to. */
function depthBudgetFor(toolName: string): number {
  return toolName.includes('assurance') ? AUTHORED_RECORD_DEPTH : ARGUMENT_DEPTH;
}

/** The enum values a discriminator tool's field can take, from its own schema. */
function enumValues(toolName: string, field: string): string[] {
  const tool = DISCRIMINATOR_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no discriminator tool named ${toolName}`);
  const shape = tool.parameters.shape as Record<string, { _def?: { values?: string[] } }>;
  return shape[field]?._def?.values ?? [];
}

describe('the named variants', () => {
  for (const variant of NAMED_VARIANTS) {
    it(`${variant} renders one tool per method, and every method once`, () => {
      const surface = renderSurface(variant);
      expect(surface.tools).toHaveLength(METHODS.length);
      expect(new Set(surface.tools.map((tool) => tool.name)).size).toBe(METHODS.length);
    });

    it(`${variant} reaches every canonical operation across its tools`, () => {
      const surface = renderSurface(variant);
      const reached = new Set<string>();
      for (const tool of surface.tools) {
        // A method that chooses between operations is asked twice, once with
        // the arguments that pick each branch, the same way a caller would.
        for (const args of [{}, { service: 'database' }, { service: 'storage' }]) {
          const call = surface.resolve(tool.name, args);
          if (call.operation !== null) reached.add(call.operation);
        }
      }
      const declared = new Set(METHODS.flatMap((method) => operationIds(method)));
      expect(reached.size).toBeGreaterThan(0);
      for (const operation of reached) expect(declared.has(operation)).toBe(true);
    });

    it(`${variant} keeps every rendered schema within its depth budget`, () => {
      for (const tool of renderSurface(variant).tools) {
        expect(schemaDepth(tool.inputSchema)).toBeLessThanOrEqual(depthBudgetFor(tool.name));
      }
    });
  }

  it('spells one method three ways across the three word orders', () => {
    expect(renderSurface('verb-prefixed').tools.map((tool) => tool.name)).toContain(
      'create_auth_user',
    );
    expect(renderSurface('noun-prefixed').tools.map((tool) => tool.name)).toContain(
      'auth_user_create',
    );
    expect(renderSurface('verb-suffixed').tools.map((tool) => tool.name)).toContain(
      'create_user_auth',
    );
  });

  it('gives each identity method a name of its own', () => {
    const names = renderSurface('verb-prefixed').tools.map((tool) => tool.name);
    expect(names).toContain('impersonate_auth_user');
    expect(names).toContain('become_auth_admin');
    expect(names).toContain('become_auth_anonymous');
    expect(names).toContain('adopt_auth_session');
  });

  it('spells every name in whole words, with no empty word left by a two-word operation', () => {
    for (const variant of NAMED_VARIANTS) {
      for (const tool of renderSurface(variant).tools) {
        expect(tool.name.startsWith('_')).toBe(false);
        expect(tool.name.endsWith('_')).toBe(false);
        expect(tool.name).not.toContain('__');
      }
    }
  });

  it('names every sandbox method after its canonical operation', () => {
    const names = renderSurface('verb-prefixed').tools.map((tool) => tool.name);
    expect(names).toContain('inspect_sandbox');
    expect(names).toContain('reset_sandbox');
    expect(names).toContain('seed_sandbox');
  });

  it('gives a verb-prefixed name that reads as a canonical id that exact operation', () => {
    const surface = renderSurface('verb-prefixed');
    for (const tool of surface.tools) {
      if (!CANONICAL_OPERATION_IDS.includes(tool.name)) continue;
      expect(surface.resolve(tool.name, {}).operation).toBe(tool.name);
    }
  });
});

describe('the discriminator variant', () => {
  const surface = renderSurface('discriminator');

  it('renders the fourteen intent tools and the seven resource templates', () => {
    expect(surface.tools).toHaveLength(14);
    expect(surface.resources).toHaveLength(7);
  });

  it('routes every operation exactly once across its tools and resources', () => {
    const covered = [
      ...DISCRIMINATOR_ROUTES.map((route) => route.operation),
      ...RESOURCE_ROUTES.map((route) => route.operation),
    ];
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it('resolves every action of every tool back to a canonical id or to none', () => {
    const reached = new Set<string>();
    for (const tool of DISCRIMINATOR_TOOLS) {
      const actions = enumValues(tool.name, 'action');
      const services = enumValues(tool.name, 'service');
      const actionValues = actions.length > 0 ? actions : [undefined];
      const serviceValues = services.length > 0 ? services : [undefined];
      for (const action of actionValues) {
        for (const service of serviceValues) {
          for (const filters of [[], [{ field: 'a', op: '==', valueJson: '1' }]]) {
            const args: Record<string, unknown> = { filters };
            if (action !== undefined) args.action = action;
            if (service !== undefined) args.service = service;
            const call = surface.resolve(tool.name, args);
            if (call.operation !== null) reached.add(call.operation);
            if (action !== undefined && call.operation !== null && call.action !== null) {
              expect(call.action).toBe(action);
            }
          }
        }
      }
    }
    for (const route of RESOURCE_ROUTES) reached.add(route.operation);
    expect([...reached].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it('separates a filtered query from a plain listing', () => {
    const listing = surface.resolve('query_sandbox_data', { service: 'firestore', path: 'users' });
    const query = surface.resolve('query_sandbox_data', {
      service: 'firestore',
      path: 'users',
      filters: [{ field: 'role', op: '==', valueJson: '"admin"' }],
    });
    expect(listing.operation).toBe('list_firestore_documents');
    expect(query.operation).toBe('query_firestore_documents');
  });

  it('resolves a discriminator value with no canonical counterpart to no operation', () => {
    const call = surface.resolve('inspect_auth_flow', { action: 'take_mail' });
    expect(call.operation).toBeNull();
    expect(call.action).toBe('take_mail');
  });

  it('keeps every rendered schema within two object levels', () => {
    for (const tool of surface.tools) {
      expect(schemaDepth(tool.inputSchema)).toBeLessThanOrEqual(2);
    }
  });
});

describe('surface selection', () => {
  it('serves the service tools when no surface is asked for', () => {
    const names = renderSurface(undefined).tools.map((tool) => tool.name);
    expect(names).toEqual(['firestore', 'database', 'storage', 'auth', 'rules', 'sandbox', 'assurance']);
  });

  it('throws for an unknown surface, naming the ones that exist', () => {
    expect(() => renderSurface('verb-infixed')).toThrow(/verb-prefixed/);
    expect(SURFACE_VARIANT_IDS).toEqual([
      'sdk-service',
      'discriminator',
      'verb-prefixed',
      'noun-prefixed',
      'verb-suffixed',
    ]);
  });
});
