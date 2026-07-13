/**
 * Smoke tests for composeMcpRegistry (pre-mortem M13). The composer
 * is the load-bearing piece that wires the @pyric/* factories into
 * a registry; even a smoke test catches the dominant failure mode
 * (a factory's return shape drifts away from ToolHandler).
 *
 * Pre-mortem X5 — also dispatches one tool through the assembled
 * registry as the end-to-end factory-chain check. A factory that
 * returns a malformed handler (missing `execute`, wrong arg shape)
 * surfaces here instead of mid-agent-run.
 */

import { describe, it, expect } from 'bun:test';
import { createDispatch } from '@inbrowser/agent';
import { composeMcpRegistry } from '../../src/registry/compose.js';

const fakeScope = {
  projectId: 'p',
  resolveToken: async () => 'TKN',
};

describe('composeMcpRegistry', () => {
  it('full profile assembles a non-empty registry', async () => {
    const registry = await composeMcpRegistry({ profile: 'full', scope: fakeScope });
    const tools = registry.list();
    expect(tools.length).toBeGreaterThan(0);
    // Auth config tools are composed (regression guard: #731 — they were
    // documented as agent tools but missing from the prod registry).
    expect(registry.has('auth_get_config')).toBe(true);
    expect(registry.has('auth_configure_provider')).toBe(true);
    expect(registry.has('firebase_assurance_start')).toBe(true);
    expect(registry.has('firebase_assurance_run')).toBe(true);
    expect(registry.has('rtdb_generate_rules')).toBe(true);
    // No duplicate names — `register` throws on conflict (F6), so
    // a duplicate would have already failed assembly.
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never registers CLI-owned production deployment tools', async () => {
    for (const profile of ['full', 'browser-parity'] as const) {
      const registry = await composeMcpRegistry({ profile, scope: fakeScope });
      for (const tool of [
        'firestore_deploy_rules',
        'firestore_deploy_indexes',
        'rtdb_deploy_rules',
        'hosting_deploy',
        'functions_deploy',
      ]) {
        expect(registry.has(tool)).toBe(false);
      }
    }
  });

  it('dispatches a tool end-to-end through the assembled registry (X5)', async () => {
    const registry = await composeMcpRegistry({ profile: 'full', scope: fakeScope });
    const dispatch = createDispatch(registry);
    const result = await dispatch.execute(
      {
        id: 'call-1',
        name: 'firestore_lint_rules',
        args: { source: "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read: if false; } } }" },
      },
      { signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('full profile (no adminDeps) includes firestore_extract_indexes', async () => {
    // Extract is pure static analysis — it lands without admin deps.
    const registry = await composeMcpRegistry({ profile: 'full', scope: fakeScope });
    expect(registry.has('firestore_extract_indexes')).toBe(true);
  });

  it('browser-parity profile drops admin-only tools', async () => {
    const registry = await composeMcpRegistry({ profile: 'browser-parity', scope: fakeScope });
    expect(registry.has('firestore_extract_indexes')).toBe(false);
    // browser-parity still has rules tooling
    expect(registry.has('firestore_lint_rules')).toBe(true);
    expect(registry.has('rtdb_generate_rules')).toBe(true);
  });
});
