import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { schemaRules } from '../../../src/database/constraints/schema.js';
import { expr } from '../../../src/database/constraints/compose.js';

describe('schemaRules', () => {
  test('z.string() → isString', () => {
    const result = schemaRules(z.object({ name: z.string() }));
    expect(result.children.name.validate).toBe('newData.isString()');
  });

  test('z.number() → isNumber', () => {
    const result = schemaRules(z.object({ age: z.number() }));
    expect(result.children.age.validate).toBe('newData.isNumber()');
  });

  test('z.boolean() → isBoolean', () => {
    const result = schemaRules(z.object({ active: z.boolean() }));
    expect(result.children.active.validate).toBe('newData.isBoolean()');
  });

  test('z.enum() → val() === comparisons', () => {
    const result = schemaRules(z.object({ role: z.enum(['user', 'admin']) }));
    expect(result.children.role.validate).toBe('newData.val() === "user" || newData.val() === "admin"');
  });

  test('z.literal(string) → val() === literal', () => {
    const result = schemaRules(z.object({ type: z.literal('post') }));
    expect(result.children.type.validate).toBe('newData.val() === "post"');
  });

  test('z.literal(number) → val() === number', () => {
    const result = schemaRules(z.object({ version: z.literal(1) }));
    expect(result.children.version.validate).toBe('newData.val() === 1');
  });

  test('z.literal(boolean) → val() === boolean', () => {
    const result = schemaRules(z.object({ enabled: z.literal(true) }));
    expect(result.children.enabled.validate).toBe('newData.val() === true');
  });

  test('required fields generate parent validate with hasChild', () => {
    const result = schemaRules(z.object({ name: z.string(), email: z.string() }));
    expect(result.validate).toContain('newData.hasChildren()');
    expect(result.validate).toContain('newData.hasChild("name")');
    expect(result.validate).toContain('newData.hasChild("email")');
  });

  test('optional fields excluded from required list', () => {
    const result = schemaRules(z.object({
      name: z.string(),
      bio: z.string().optional(),
    }));
    expect(result.validate).toContain('newData.hasChild("name")');
    expect(result.validate).not.toContain('newData.hasChild("bio")');
    // But bio still gets a child validate rule
    expect(result.children.bio.validate).toBe('newData.isString()');
  });

  test('nested z.object() produces nested children', () => {
    const result = schemaRules(z.object({
      address: z.object({
        city: z.string(),
        zip: z.string(),
      }),
    }));
    expect(result.children.address.validate).toContain('newData.hasChildren()');
    expect(result.children.address.children).toBeDefined();
    expect(result.children.address.children!.city.validate).toBe('newData.isString()');
    expect(result.children.address.children!.zip.validate).toBe('newData.isString()');
  });

  test('z.union of primitives → OR of type checks', () => {
    const result = schemaRules(z.object({
      value: z.union([z.string(), z.number()]),
    }));
    expect(result.children.value.validate).toBe('(newData.isString()) || (newData.isNumber())');
  });

  test('fieldConstraints merge with schema via all()', () => {
    const result = schemaRules(
      z.object({ author: z.string() }),
      { author: [expr('newData.val() === auth.uid')] },
    );
    expect(result.children.author.validate).toBe('(newData.isString()) && (newData.val() === auth.uid)');
  });

  test('fieldConstraints with multiple constraints', () => {
    const result = schemaRules(
      z.object({ createdAt: z.number() }),
      { createdAt: [expr('!data.exists() || newData.val() === data.val()'), expr('newData.val() <= now')] },
    );
    expect(result.children.createdAt.validate).toContain('newData.isNumber()');
    expect(result.children.createdAt.validate).toContain('!data.exists() || newData.val() === data.val()');
    expect(result.children.createdAt.validate).toContain('newData.val() <= now');
  });

  test('unsupported z.array() throws', () => {
    expect(() => schemaRules(z.object({ tags: z.array(z.string()) }))).toThrow('Unsupported');
  });

  test('unsupported z.date() throws', () => {
    expect(() => schemaRules(z.object({ date: z.date() }))).toThrow('Unsupported');
  });

  test('empty object → just hasChildren()', () => {
    const result = schemaRules(z.object({}));
    expect(result.validate).toBe('(newData.hasChildren())');
    expect(Object.keys(result.children)).toHaveLength(0);
  });
});
