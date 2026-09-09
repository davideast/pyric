/** Every variant exposes every operation exactly once, at a schema depth of at most two. */
import { describe, expect, it } from 'bun:test';

import { renderSurface, SURFACE_VARIANT_IDS } from '../../../src/bridge/surface/index.js';
import { OPERATIONS } from '../../../src/bridge/surface/operations/index.js';
import { schemaDepth } from '../../../src/bridge/surface/json-schema.js';
import {
  DISCRIMINATOR_ROUTES,
  DISCRIMINATOR_TOOLS,
} from '../../../src/bridge/surface/render/discriminator-routes.js';
import { RESOURCE_ROUTES } from '../../../src/bridge/surface/render/discriminator-resources.js';
import { CANONICAL_OPERATION_IDS } from './canonical-operations.js';

const NAMED_VARIANTS = ['verb-prefixed', 'noun-prefixed', 'verb-suffixed'];

/** The enum values a discriminator tool's field can take, from its own schema. */
function enumValues(toolName: string, field: string): string[] {
  const tool = DISCRIMINATOR_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no discriminator tool named ${toolName}`);
  const shape = tool.parameters.shape as Record<string, { _def?: { values?: string[] } }>;
  return shape[field]?._def?.values ?? [];
}

describe('the named variants', () => {
  for (const variant of NAMED_VARIANTS) {
    it(`${variant} renders one tool per operation, and every operation once`, () => {
      const surface = renderSurface(variant);
      expect(surface.tools).toHaveLength(OPERATIONS.length);

      const resolved = surface.tools.map((tool) => surface.resolve(tool.name, {}).operation);
      expect(resolved.every((operation) => operation !== null)).toBe(true);
      expect(new Set(resolved).size).toBe(OPERATIONS.length);
      expect([...resolved].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
    });

    it(`${variant} keeps every rendered schema within two object levels`, () => {
      for (const tool of renderSurface(variant).tools) {
        expect(schemaDepth(tool.inputSchema)).toBeLessThanOrEqual(2);
      }
    });
  }

  it('names verb-prefixed tools with the canonical id itself', () => {
    const names = renderSurface('verb-prefixed').tools.map((tool) => tool.name);
    expect([...names].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it('reorders the same words for the other two patterns', () => {
    const nouns = renderSurface('noun-prefixed').tools.map((tool) => tool.name);
    const verbs = renderSurface('verb-suffixed').tools.map((tool) => tool.name);
    expect(nouns).toContain('auth_user_create');
    expect(verbs).toContain('create_user_auth');
  });
});

describe('the discriminator variant', () => {
  const surface = renderSurface('discriminator');

  it('renders the twelve intent tools and the seven resource templates', () => {
    expect(surface.tools).toHaveLength(12);
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
    const call = surface.resolve('manage_auth_users', { action: 'mint_token' });
    expect(call.operation).toBeNull();
    expect(call.action).toBe('mint_token');
  });

  it('keeps every rendered schema within two object levels', () => {
    for (const tool of surface.tools) {
      expect(schemaDepth(tool.inputSchema)).toBeLessThanOrEqual(2);
    }
  });
});

describe('surface selection', () => {
  it('serves the default surface when no variant is asked for', () => {
    const names = renderSurface(undefined).tools.map((tool) => tool.name);
    expect(names).toContain('firestore_create_document');
    expect(names).toContain('sandbox_inspect');
  });

  it('throws for an unknown variant, naming the ones that exist', () => {
    expect(() => renderSurface('verb-infixed')).toThrow(/verb-prefixed/);
    expect(SURFACE_VARIANT_IDS).toEqual([
      'discriminator',
      'verb-prefixed',
      'noun-prefixed',
      'verb-suffixed',
    ]);
  });
});
