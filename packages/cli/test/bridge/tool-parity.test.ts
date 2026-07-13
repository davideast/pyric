/**
 * Tool parity: the set the bridge ADVERTISES (`getSandboxToolMetadata`)
 * must equal the set the page peer EXECUTES (`SANDBOX_TOOL_NAMES`, derived
 * from the same factories as `buildSandboxDispatcher`). Both derive from
 * the simulator + data-plane + inspect factories.
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

  it('includes the data-plane + inspect tools that regressed (the bug this guards)', () => {
    const names = new Set(SANDBOX_TOOL_NAMES);
    for (const t of [
      'firestore_create_document',
      'firestore_get_document',
      'firestore_list_documents',
      'firestore_update_document',
      'firestore_delete_document',
      'firestore_query_where',
      'sandbox_inspect',
      'firebase_assurance_attach',
      'firebase_assurance_run',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });
});
