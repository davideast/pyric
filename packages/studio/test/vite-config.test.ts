import { describe, expect, it } from 'bun:test';
import type { PluginOption, UserConfig } from 'vite';
import config, { studioSandboxOptions } from '../vite.config';

function pluginNames(options: PluginOption[]): string[] {
  return options.flatMap((option) => {
    if (!option) return [];
    if (Array.isArray(option)) return pluginNames(option);
    return [option.name];
  });
}

describe('Studio Vite development config', () => {
  it('mounts the Pyric runtime that owns the default SharedWorker URL', () => {
    const names = pluginNames((config as UserConfig).plugins ?? []);

    // The runtime plugin serves /__pyric/sdk/worker.js. Without it, Vite's SPA
    // fallback returns index.html and SharedWorker fails on the leading "<".
    expect(names).toContain('pyric:sandbox');
  });

  it('serves Studio while retaining the shared sandbox runtime', () => {
    expect(studioSandboxOptions.ui).toBe(true);
  });
});
