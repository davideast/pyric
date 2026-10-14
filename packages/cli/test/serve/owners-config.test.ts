/** The project's listener-owner settings, from pyric.json and the Vite plugin. */
import { describe, expect, it } from 'bun:test';
import { resolveOwnersConfig } from '../../src/serve/owners-config.js';

describe('resolveOwnersConfig', () => {
  it('reads skip globs and a frame count from pyric.json', () => {
    expect(resolveOwnersConfig({ skip: ['src/db/**'], frames: 5 })).toEqual({ skip: ['src/db/**'], frames: 5 });
  });

  it('lets the plugin option replace a pyric.json field and keep the other', () => {
    expect(resolveOwnersConfig({ skip: ['src/db/**'], frames: 5 }, { skip: ['common/db/**'] }))
      .toEqual({ skip: ['common/db/**'], frames: 5 });
  });

  it('reports no settings when neither source sets any', () => {
    expect(resolveOwnersConfig(undefined)).toBeUndefined();
    expect(resolveOwnersConfig({}, {})).toBeUndefined();
  });

  it('refuses settings it cannot apply, naming the field', () => {
    expect(() => resolveOwnersConfig(['src/db/**'])).toThrow('pyric.json owners must be an object');
    expect(() => resolveOwnersConfig({ skip: 'src/db/**' })).toThrow('pyric.json owners.skip');
    expect(() => resolveOwnersConfig({ skip: [''] })).toThrow('pyric.json owners.skip');
    expect(() => resolveOwnersConfig({ frames: 0 })).toThrow('pyric.json owners.frames');
    expect(() => resolveOwnersConfig(undefined, { frames: 2.5 })).toThrow('pyric({ owners }).frames');
  });
});
