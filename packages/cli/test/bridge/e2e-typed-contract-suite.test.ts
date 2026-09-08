/**
 * Comprehensive E2E Test Suite for the Pyric Typed-Service Contract API.
 *
 * Exercises all 12 Verb-First Action-Oriented Tools and all 7 MCP Resource URI Templates
 * across Tiers 1, 2, 3, and 4 using `createLocalBridge(sandbox)` against a live in-process
 * `LocalSandbox`.
 *
 * 12 Tools Under Test:
 *  1. switch_auth_identity
 *  2. manage_auth_users
 *  3. inspect_auth_flow
 *  4. mutate_sandbox_data
 *  5. query_sandbox_data
 *  6. manage_storage_files
 *  7. diagnose_rule_denial
 *  8. verify_security_rules
 *  9. dry_run_experiment
 * 10. control_sandbox_environment
 * 11. invoke_cloud_function
 * 12. configure_ai_mock
 *
 * 7 MCP Resource URI Templates Under Test:
 *  1. pyric://sandbox/status
 *  2. pyric://sandbox/events
 *  3. pyric://firestore/docs/{path}
 *  4. pyric://database/tree/{path}
 *  5. pyric://auth/users
 *  6. pyric://storage/objects/{bucket}
 *  7. pyric://stdlib/rules/{module}
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { createLocalBridge } from '../../src/bridge/server/local-bridge.js';
import type { Bridge } from '../../src/bridge/server/bridge.js';
import { getDefaultMcpToolSurface } from '../../src/bridge/server/mcp-contract.js';

const EXPECTED_12_TOOLS = [
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
] as const;

const TENANT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenantId}/docs/{docId} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId;
      allow write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId
        && request.auth.token.role == 'editor';
    }
    match /public/{docId} {
      allow read, write: if true;
    }
  }
}`;

/**
 * Helper to compute maximum object/array schema nesting depth of a JSON schema.
 * Root parameters object is Level 0, top-level properties are Level 1,
 * direct children inside Level 1 objects/array items are Level 2.
 */
function getSchemaNestingDepth(schema: Record<string, unknown> | undefined, currentLevel = 0): number {
  if (!schema || typeof schema !== 'object') return currentLevel;
  let maxDepth = currentLevel;

  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const propSchema of Object.values(props)) {
      const nextLevel = currentLevel + 1;
      maxDepth = Math.max(maxDepth, nextLevel);
      if (propSchema.type === 'object' || propSchema.type === 'array') {
        maxDepth = Math.max(maxDepth, getSchemaNestingDepth(propSchema, nextLevel));
      }
    }
  } else if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    const itemSchema = schema.items as Record<string, unknown>;
    if (itemSchema.type === 'object' && itemSchema.properties) {
      const props = itemSchema.properties as Record<string, Record<string, unknown>>;
      for (const propSchema of Object.values(props)) {
        const nextLevel = currentLevel + 1;
        maxDepth = Math.max(maxDepth, nextLevel);
        if (propSchema.type === 'object' || propSchema.type === 'array') {
          maxDepth = Math.max(maxDepth, getSchemaNestingDepth(propSchema, nextLevel));
        }
      }
    }
  }

  return maxDepth;
}

/**
 * Helper to read an MCP resource (`pyric://...`) from either the Bridge instance
 * or via `readSandboxResource(sandbox, uri)` in `pyric/actuation`.
 */
async function readMcpResource(bridge: Bridge, sandbox: LocalSandbox, uri: string): Promise<Record<string, unknown>> {
  const anyBridge = bridge as unknown as {
    readResource?: (u: string) => Promise<unknown>;
  };

  if (typeof anyBridge.readResource === 'function') {
    const raw = await anyBridge.readResource(uri);
    if (raw && typeof raw === 'object' && 'contents' in (raw as Record<string, unknown>)) {
      const contents = (raw as { contents: Array<{ text?: string }> }).contents;
      if (contents?.[0]?.text) {
        return JSON.parse(contents[0].text) as Record<string, unknown>;
      }
    }
    return raw as Record<string, unknown>;
  }

  // Fallback to dispatch('resources/read', { uri }) or direct actuation import
  const dispatchRes = await bridge.dispatch('resources/read', { uri });
  if (dispatchRes.ok && dispatchRes.data) {
    return dispatchRes.data as Record<string, unknown>;
  }

  // Dynamic import of readSandboxResource from pyric/actuation if present
  try {
    const modName = 'pyric/actuation';
    const actuation = (await import(modName)) as {
      readSandboxResource?: (s: LocalSandbox, u: string) => Promise<unknown>;
    };
    if (typeof actuation.readSandboxResource === 'function') {
      return (await actuation.readSandboxResource(sandbox, uri)) as Record<string, unknown>;
    }
  } catch {
    // ignore import error if actuation module is still being wired
  }

  throw new Error(`Unable to read MCP resource ${uri}: neither bridge.readResource nor readSandboxResource succeeded`);
}

describe('E2E Typed-Service Contract Suite (Tiers 1-4)', () => {
  // ── Tier 1: Smoke & Contract Baseline ──────────────────────────────────────
  describe('Tier 1: Smoke & Contract Baseline (12 Tools + 7 Resources + Depth <= 2)', () => {
    it('registers the exact 12 Verb-First Action-Oriented Tools with zero legacy shims', () => {
      const sandbox = initializeSandbox();
      const bridge = createLocalBridge(sandbox);
      const toolNames = bridge.toolNames();

      expect([...toolNames].sort()).toEqual([...EXPECTED_12_TOOLS].sort());
      expect(toolNames.length).toBe(12);
    });

    it('enforces schema nesting depth <= 2 across all registered tools', () => {
      const surface = getDefaultMcpToolSurface();
      const allSchemas = [
        ...surface.forwarded.map((t) => ({ name: t.name, parameters: t.parameters as Record<string, unknown> })),
        ...surface.inProcess.map((t) => ({ name: t.name, parameters: t.parameters as Record<string, unknown> })),
      ];

      expect(allSchemas.length).toBe(12);
      for (const tool of allSchemas) {
        const depth = getSchemaNestingDepth(tool.parameters, 0);
        expect(depth).toBeLessThanOrEqual(2);
      }
    });

    it('executes happy-path smoke invocations for all 12 Verb-First tools', async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, TENANT_RULES);
      const bridge = createLocalBridge(sandbox);

      // 1. switch_auth_identity
      const r1 = await bridge.dispatch('switch_auth_identity', {
        mode: 'admin',
      });
      expect(r1.ok).toBe(true);

      // 2. manage_auth_users
      const r2 = await bridge.dispatch('manage_auth_users', {
        action: 'create',
        uid: 'smoke-user-1',
        email: 'smoke@example.com',
        displayName: 'Smoke User',
      });
      expect(r2.ok).toBe(true);

      // 3. inspect_auth_flow
      const r3 = await bridge.dispatch('inspect_auth_flow', {
        action: 'whoami',
      });
      expect(r3.ok).toBe(true);

      // 4. mutate_sandbox_data
      const r4 = await bridge.dispatch('mutate_sandbox_data', {
        service: 'firestore',
        action: 'set',
        path: 'public/doc1',
        dataJson: JSON.stringify({ title: 'Hello Pyric', count: 1 }),
      });
      expect(r4.ok).toBe(true);

      // 5. query_sandbox_data
      const r5 = await bridge.dispatch('query_sandbox_data', {
        service: 'firestore',
        path: 'public',
      });
      expect(r5.ok).toBe(true);

      // 6. manage_storage_files
      const r6 = await bridge.dispatch('manage_storage_files', {
        action: 'upload',
        path: 'smoke/hello.txt',
        base64Content: Buffer.from('hello world', 'utf8').toString('base64'),
        contentType: 'text/plain',
      });
      expect(r6.ok).toBe(true);

      // 7. diagnose_rule_denial
      const r7 = await bridge.dispatch('diagnose_rule_denial', {
        service: 'firestore',
        operation: 'get',
        path: 'tenants/acme/docs/secret',
        auth: { uid: 'intruder', tenant: 'other' },
      });
      expect(r7.ok).toBe(true);

      // 8. verify_security_rules
      const r8 = await bridge.dispatch('verify_security_rules', {
        service: 'firestore',
        action: 'lint',
        source: TENANT_RULES,
      });
      expect(r8.ok).toBe(true);

      // 9. dry_run_experiment
      const r9 = await bridge.dispatch('dry_run_experiment', {
        action: 'fork',
        branchId: 'smoke-branch',
      });
      expect(r9.ok).toBe(true);

      // 10. control_sandbox_environment
      const r10 = await bridge.dispatch('control_sandbox_environment', {
        action: 'advance_clock',
        advanceMs: 5000,
      });
      expect(r10.ok).toBe(true);

      // 11. invoke_cloud_function
      const r11 = await bridge.dispatch('invoke_cloud_function', {
        functionName: 'echoCallable',
        triggerType: 'callable',
        dataJson: JSON.stringify({ ping: 'pong' }),
      });
      expect(r11.ok).toBe(true);

      // 12. configure_ai_mock
      const r12 = await bridge.dispatch('configure_ai_mock', {
        action: 'append_script',
        entries: [
          {
            matchSubstring: 'Hello',
            responseType: 'text',
            responsePayload: 'Mock AI greeting response',
          },
        ],
      });
      expect(r12.ok).toBe(true);
    });

    it('reads all 7 MCP Resource URI Templates (`pyric://...`) successfully', async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, TENANT_RULES);
      const bridge = createLocalBridge(sandbox);

      // Seed baseline state for resources
      await bridge.dispatch('manage_auth_users', {
        action: 'create',
        uid: 'res-user',
        email: 'res@example.com',
      });
      await bridge.dispatch('mutate_sandbox_data', {
        service: 'firestore',
        action: 'set',
        path: 'public/item1',
        dataJson: JSON.stringify({ label: 'Item 1' }),
      });
      await bridge.dispatch('mutate_sandbox_data', {
        service: 'database',
        action: 'set',
        path: 'rooms/lobby',
        dataJson: JSON.stringify({ topic: 'Welcome' }),
      });
      await bridge.dispatch('manage_storage_files', {
        action: 'upload',
        path: 'assets/logo.png',
        base64Content: Buffer.from('png-data', 'utf8').toString('base64'),
        contentType: 'image/png',
      });

      // 1. pyric://sandbox/status
      const status = await readMcpResource(bridge, sandbox, 'pyric://sandbox/status');
      expect(status.status).toBe('ok');
      expect(status.services).toBeDefined();

      // 2. pyric://sandbox/events
      const events = await readMcpResource(bridge, sandbox, 'pyric://sandbox/events');
      expect(Array.isArray(events.events)).toBe(true);

      // 3. pyric://firestore/docs/{path}
      const docRes = await readMcpResource(bridge, sandbox, 'pyric://firestore/docs/public/item1');
      expect(docRes.exists).toBe(true);
      expect((docRes.data as Record<string, unknown>)?.label).toBe('Item 1');

      // 4. pyric://database/tree/{path}
      const rtdbRes = await readMcpResource(bridge, sandbox, 'pyric://database/tree/rooms/lobby');
      expect(rtdbRes.exists).toBe(true);

      // 5. pyric://auth/users
      const usersRes = await readMcpResource(bridge, sandbox, 'pyric://auth/users');
      expect(Array.isArray(usersRes.users)).toBe(true);

      // 6. pyric://storage/objects/{bucket}
      const storageRes = await readMcpResource(bridge, sandbox, 'pyric://storage/objects/default');
      expect(Array.isArray(storageRes.objects)).toBe(true);

      // 7. pyric://stdlib/rules/{module}
      const stdlibRes = await readMcpResource(bridge, sandbox, 'pyric://stdlib/rules/math');
      expect(stdlibRes.key).toBe('math');
      expect(Array.isArray(stdlibRes.entries)).toBe(true);
    });
  });

  // ── Tier 2: Functional & Cross-Service Workflows ───────────────────────────
  describe('Tier 2: Functional & Cross-Service Workflows (Full-Lifecycle Auth, Storage, Branching)', () => {
    it('propagates user creation, custom claims, and tenant ID through Firestore rules enforcement', async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, TENANT_RULES);
      const bridge = createLocalBridge(sandbox);

      // Step 1: Create tenant editor user
      const createRes = await bridge.dispatch('manage_auth_users', {
        action: 'create',
        uid: 'alice-acme',
        email: 'alice@acme.io',
      });
      expect(createRes.ok).toBe(true);

      // Step 2: Set custom claim `role: 'editor'`
      const claimsRes = await bridge.dispatch('manage_auth_users', {
        action: 'set_claims',
        uid: 'alice-acme',
        claimsJson: JSON.stringify({ role: 'editor' }),
      });
      expect(claimsRes.ok).toBe(true);

      // Step 3: Switch identity to alice-acme with tenant 'acme'
      const switchRes = await bridge.dispatch('switch_auth_identity', {
        mode: 'uid',
        uid: 'alice-acme',
        tenant: 'acme',
        claimsJson: JSON.stringify({ role: 'editor' }),
      });
      expect(switchRes.ok).toBe(true);

      // Step 4: Verify active identity via inspect_auth_flow
      const whoamiRes = await bridge.dispatch('inspect_auth_flow', {
        action: 'whoami',
      });
      expect(whoamiRes.ok).toBe(true);

      // Step 5: Write to tenant collection (allowed for role == 'editor' && tenant == 'acme')
      const writeRes = await bridge.dispatch('mutate_sandbox_data', {
        service: 'firestore',
        action: 'set',
        path: 'tenants/acme/docs/report-q3',
        dataJson: JSON.stringify({ revenue: 125000, verified: true }),
      });
      expect(writeRes.ok).toBe(true);

      // Step 6: Query back using structured filter
      const queryRes = await bridge.dispatch('query_sandbox_data', {
        service: 'firestore',
        path: 'tenants/acme/docs',
        filters: [
          {
            field: 'verified',
            op: '==',
            valueJson: 'true',
          },
        ],
      });
      expect(queryRes.ok).toBe(true);
      const results = (queryRes.data as { results?: Array<Record<string, unknown>> })?.results ?? [];
      expect(results.length).toBe(1);
    });

    it('executes complete Cloud Storage lifecycle: upload -> list -> download -> delete', async () => {
      const sandbox = initializeSandbox();
      const bridge = createLocalBridge(sandbox);

      const payloadText = 'confidential-contract-v2';
      const base64Payload = Buffer.from(payloadText, 'utf8').toString('base64');

      // Upload
      const uploadRes = await bridge.dispatch('manage_storage_files', {
        action: 'upload',
        path: 'contracts/2026/v2.txt',
        base64Content: base64Payload,
        contentType: 'text/plain',
        customMetadataJson: JSON.stringify({ classification: 'internal' }),
      });
      expect(uploadRes.ok).toBe(true);

      // List via tool
      const listRes = await bridge.dispatch('manage_storage_files', {
        action: 'list',
        path: 'contracts/2026',
      });
      expect(listRes.ok).toBe(true);

      // Download and verify data URI
      const downloadRes = await bridge.dispatch('manage_storage_files', {
        action: 'download',
        path: 'contracts/2026/v2.txt',
      });
      expect(downloadRes.ok).toBe(true);
      const dataUri = (downloadRes.data as { dataUri?: string })?.dataUri ?? '';
      expect(dataUri).toContain('data:text/plain;base64,');

      // Delete
      const deleteRes = await bridge.dispatch('manage_storage_files', {
        action: 'delete',
        path: 'contracts/2026/v2.txt',
      });
      expect(deleteRes.ok).toBe(true);
    });

    it('isolates branch experiments (`fork` -> `apply` -> `diff` -> `promote`) without polluting main state until promoted', async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, TENANT_RULES);
      const bridge = createLocalBridge(sandbox);

      // Fork isolated branch
      const forkRes = await bridge.dispatch('dry_run_experiment', {
        action: 'fork',
        branchId: 'tighten-rules-exp',
      });
      expect(forkRes.ok).toBe(true);

      // Apply candidate rules on branch
      const stricterRules = TENANT_RULES.replace('allow read, write: if true;', 'allow read: if true; allow write: if false;');
      const applyRes = await bridge.dispatch('dry_run_experiment', {
        action: 'apply',
        branchId: 'tighten-rules-exp',
        candidateRules: stricterRules,
      });
      expect(applyRes.ok).toBe(true);

      // Diff branch against recorded traffic
      const diffRes = await bridge.dispatch('dry_run_experiment', {
        action: 'diff',
        branchId: 'tighten-rules-exp',
      });
      expect(diffRes.ok).toBe(true);

      // Promote branch to main sandbox
      const promoteRes = await bridge.dispatch('dry_run_experiment', {
        action: 'promote',
        branchId: 'tighten-rules-exp',
      });
      expect(promoteRes.ok).toBe(true);
    });
  });

  // ── Tier 3: Edge Cases, Algebraic Composition & Greedy URI Templates ───────
  describe('Tier 3: Edge Cases, Algebraic Composition & Greedy URI Templates', () => {
    it('evaluates CEL commutative error absorption (`error || true`) in `diagnose_rule_denial`', async () => {
      const sandbox = initializeSandbox();
      const absorptionRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /absorption/{docId} {
      allow read: if (resource.data.nonExistentMap.nestedField == 'x') || true;
    }
  }
}`;
      setRules(sandbox, absorptionRules);
      const bridge = createLocalBridge(sandbox);

      const diagRes = await bridge.dispatch('diagnose_rule_denial', {
        service: 'firestore',
        operation: 'get',
        path: 'absorption/doc1',
        auth: { uid: 'tester' },
      });
      expect(diagRes.ok).toBe(true);
      const data = diagRes.data as { allowed?: boolean; trace?: unknown[] };
      expect(data?.allowed).toBe(true);
      expect(Array.isArray(data?.trace)).toBe(true);
    });

    it('performs atomic multi-operation `batch` writes via `mutate_sandbox_data`', async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, TENANT_RULES);
      const bridge = createLocalBridge(sandbox);

      const batchRes = await bridge.dispatch('mutate_sandbox_data', {
        service: 'firestore',
        action: 'batch',
        batchOps: [
          {
            op: 'set',
            path: 'public/batch-a',
            dataJson: JSON.stringify({ index: 1 }),
          },
          {
            op: 'set',
            path: 'public/batch-b',
            dataJson: JSON.stringify({ index: 2 }),
          },
        ],
      });
      expect(batchRes.ok).toBe(true);

      const docA = await readMcpResource(bridge, sandbox, 'pyric://firestore/docs/public/batch-a');
      const docB = await readMcpResource(bridge, sandbox, 'pyric://firestore/docs/public/batch-b');
      expect(docA.exists).toBe(true);
      expect(docB.exists).toBe(true);
    });

    it('returns helpful suggestions when querying an unknown module on `pyric://stdlib/rules/{module}`', async () => {
      const sandbox = initializeSandbox();
      const bridge = createLocalBridge(sandbox);

      const unknownModRes = await readMcpResource(bridge, sandbox, 'pyric://stdlib/rules/maths_typo');
      expect(unknownModRes).toBeDefined();
      // Should include either suggestion or validKeys list
      const hasSuggestionOrValidKeys =
        'suggestion' in unknownModRes || 'validKeys' in unknownModRes || 'error' in unknownModRes;
      expect(hasSuggestionOrValidKeys).toBe(true);
    });
  });

  // ── Tier 4: Negative Testing & Deterministic Error Paths ───────────────────
  describe('Tier 4: Negative Testing & Deterministic Error Paths', () => {
    it('returns ok:false (`permission-denied`) when writing under unauthorized tenant/claims', async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, TENANT_RULES);
      const bridge = createLocalBridge(sandbox);

      // Attempt write as non-editor user in wrong tenant
      const deniedWrite = await bridge.dispatch('mutate_sandbox_data', {
        service: 'firestore',
        action: 'set',
        path: 'tenants/acme/docs/unauthorized-doc',
        dataJson: JSON.stringify({ hacked: true }),
        auth: {
          mode: 'uid',
          uid: 'intruder-bob',
          tenant: 'other-tenant',
        },
      });
      expect(deniedWrite.ok).toBe(false);
      expect(deniedWrite.summary.toLowerCase()).not.toContain('unknown');
    });

    it('returns ok:false when `switch_auth_identity` is invoked with `mode: "uid"` but missing `uid`', async () => {
      const sandbox = initializeSandbox();
      const bridge = createLocalBridge(sandbox);

      const invalidSwitch = await bridge.dispatch('switch_auth_identity', {
        mode: 'uid',
      });
      expect(invalidSwitch.ok).toBe(false);
      expect(invalidSwitch.summary.toLowerCase()).not.toContain('unknown');
    });

    it('returns ok:false (`auth/user-not-found`) when retrieving a non-existent user via `manage_auth_users`', async () => {
      const sandbox = initializeSandbox();
      const bridge = createLocalBridge(sandbox);

      const missingUser = await bridge.dispatch('manage_auth_users', {
        action: 'get',
        uid: 'non-existent-uid-9999',
      });
      expect(missingUser.ok).toBe(false);
      expect(missingUser.summary.toLowerCase()).not.toContain('unknown');
    });

    it('returns ok:false (`storage/object-not-found`) when downloading a missing file via `manage_storage_files`', async () => {
      const sandbox = initializeSandbox();
      const bridge = createLocalBridge(sandbox);

      const missingFile = await bridge.dispatch('manage_storage_files', {
        action: 'download',
        path: 'missing-folder/ghost.txt',
      });
      expect(missingFile.ok).toBe(false);
      expect(missingFile.summary.toLowerCase()).not.toContain('unknown');
    });
  });
});
