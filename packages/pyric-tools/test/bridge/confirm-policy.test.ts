/**
 * Tests for confirm-policy.ts — pure data + lookup, no I/O.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROD_POLICIES,
  DEFAULT_SANDBOX_POLICY,
  FALLBACK_PROD_POLICY,
  buildPolicyMap,
  policyFor,
  type ConfirmPolicy,
} from '../../src/bridge/server/confirm-policy.js';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';
import { ASSURANCE_TOOL_NAMES } from '../../src/assurance/tool-names.js';

describe('DEFAULT_PROD_POLICIES table', () => {
  test('reads are never', () => {
    const reads = [
      'firestore_get_document',
      'firestore_list_documents',
      'firestore_get_rules',
      'rtdb_get',
    ];
    for (const name of reads) {
      expect(DEFAULT_PROD_POLICIES.get(name)).toBe('never');
    }
    for (const name of ASSURANCE_TOOL_NAMES) {
      expect(DEFAULT_PROD_POLICIES.get(name)).toBe('never');
    }
  });

  test('writes are always', () => {
    const writes = [
      'firestore_create_document',
      'firestore_update_document',
      'firestore_delete_document',
      'rtdb_set',
      'rtdb_delete',
    ];
    for (const name of writes) {
      expect(DEFAULT_PROD_POLICIES.get(name)).toBe('always');
    }
  });

  test('deploys are always', () => {
    const deploys = [
      'firestore_deploy_rules',
      'firestore_provision_database',
      'firestore_deploy_indexes',
      'firestore_create_index',
      'rtdb_deploy_rules',
      'hosting_deploy',
      'functions_deploy',
    ];
    for (const name of deploys) {
      expect(DEFAULT_PROD_POLICIES.get(name)).toBe('always');
    }
  });

  test('pure compute tools are never', () => {
    expect(DEFAULT_PROD_POLICIES.get('firestore_lint_rules')).toBe('never');
    expect(DEFAULT_PROD_POLICIES.get('firestore_simulate_rules')).toBe('never');
    expect(DEFAULT_PROD_POLICIES.get('rtdb_build_expression')).toBe('never');
  });

  test('sandbox-mode default is never', () => {
    expect(DEFAULT_SANDBOX_POLICY).toBe('never');
  });

  test('prod-mode fallback is always (fail-safe)', () => {
    expect(FALLBACK_PROD_POLICY).toBe('always');
  });
});

describe('buildPolicyMap', () => {
  test('returns a copy — does not mutate the base', () => {
    const base = new Map<string, ConfirmPolicy>([['x', 'always']]);
    const result = buildPolicyMap(base, { autoApprove: ['x'] });
    expect(result.get('x')).toBe('never');
    expect(base.get('x')).toBe('always'); // base unchanged
  });

  test('autoApprove lowers tools to never', () => {
    const result = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      autoApprove: ['firestore_create_document'],
    });
    expect(result.get('firestore_create_document')).toBe('never');
  });

  test('requireConfirm raises tools to always (overrides never)', () => {
    const result = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      requireConfirm: ['firestore_get_document'],
    });
    expect(result.get('firestore_get_document')).toBe('always');
  });

  test('requireConfirm overrides autoApprove for the same tool', () => {
    const result = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      autoApprove: ['firestore_delete_document'],
      requireConfirm: ['firestore_delete_document'],
    });
    expect(result.get('firestore_delete_document')).toBe('always');
  });

  test('requireConfirmAll raises every key to always', () => {
    const result = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      requireConfirmAll: true,
    });
    for (const value of result.values()) {
      expect(value).toBe('always');
    }
  });

  test('autoApprove can introduce new tool keys', () => {
    const result = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      autoApprove: ['some_brand_new_tool'],
    });
    expect(result.get('some_brand_new_tool')).toBe('never');
  });
});

describe('policyFor', () => {
  test('returns mapped policy when tool is known', () => {
    const policies = new Map<string, ConfirmPolicy>([
      ['known', 'never'],
    ]);
    expect(policyFor(policies, 'known')).toBe('never');
  });

  test('falls back to FALLBACK_PROD_POLICY for unknown tools by default', () => {
    const policies = new Map<string, ConfirmPolicy>();
    expect(policyFor(policies, 'unknown')).toBe('always');
  });

  test('accepts custom fallback', () => {
    const policies = new Map<string, ConfirmPolicy>();
    expect(policyFor(policies, 'unknown', 'never')).toBe('never');
  });
});

describe('coverage', () => {
  test('every sandbox tool name is also a key in DEFAULT_PROD_POLICIES (for consistency)', () => {
    // Sandbox-mode tools don't strictly need prod policies, but if a
    // tool ever shows up in both surfaces, having a policy avoids
    // accidentally falling through to the `always` fallback.
    // Use this test as a discoverability check — if a new sandbox
    // tool is added, this test fails until a policy is set or it's
    // explicitly excluded.
    const sandboxOnlySetIntentionally = new Set([
      // simulator tools are sandbox-only by design; we deliberately
      // do NOT include them in prod policies (they wouldn't be
      // registered in prod-mode anyway). Listed here so the test
      // documents the choice.
      'firestore_simulator_create',
      'firestore_simulator_execute',
      'firestore_simulator_read',
      'firestore_simulator_batch',
      'firestore_create_with_auto_id',
      'firestore_simulator_undo',
      'firestore_simulator_redo',
      'firestore_simulator_events',
      'firestore_simulator_transaction',
    ]);
    for (const name of SANDBOX_TOOL_NAMES) {
      if (sandboxOnlySetIntentionally.has(name)) continue;
      expect(DEFAULT_PROD_POLICIES.has(name)).toBe(true);
    }
  });
});
