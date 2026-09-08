/**
 * Tool parity: the set the bridge ADVERTISES (`getSandboxToolMetadata`)
 * must equal the set the page peer EXECUTES (`SANDBOX_TOOL_NAMES`). The
 * first is composed from the Node factory map, the second is read from the
 * family records under `src/bridge/tool-family-records/`.
 *
 * A drift here is the "tool 'X' is not registered with the connected
 * sandbox peer" bug: the bridge lists a tool an agent can call, but the
 * page can't execute it (succeed-at-list, fail-at-dispatch). This test
 * makes that drift a build failure.
 */
import { describe, expect, it } from 'bun:test';
import { getSandboxToolMetadata } from '../../src/bridge/server/tool-metadata.js';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';

describe('sandbox tool parity (advertised == executable)', () => {
  it('every advertised tool is executable by the page dispatcher (and vice versa)', () => {
    const advertised = getSandboxToolMetadata()
      .map((t) => t.name)
      .sort();
    const executable = [...SANDBOX_TOOL_NAMES].sort();
    expect(executable).toEqual(advertised);
  });

  it('includes the 12 Verb-First action-oriented tools across data, auth, storage, and environment', () => {
    const names = new Set(SANDBOX_TOOL_NAMES);
    for (const t of [
      'switch_auth_identity',
      'manage_auth_users',
      'inspect_auth_flow',
      'mutate_sandbox_data',
      'query_sandbox_data',
      'manage_storage_files',
      'diagnose_rule_denial',
      'verify_security_rules',
      'dry_run_experiment',
      'control_sandbox_environment',
      'invoke_cloud_function',
      'configure_ai_mock',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });
});
