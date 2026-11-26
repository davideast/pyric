import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryBackend, type RequestEvent, type SandboxEvent } from 'pyric/sandbox';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { HostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';
import { createLiveHostState } from '../../../src/serve/live-host-state.js';
import { rulesFilesOf } from '../../../src/serve/live-terminal-lines.js';
import { FIREBASE_RULES_API_ORIGIN } from '../../../src/serve/observed-session/deployed-rules-http.js';
import { chipRequestFromEvent } from '../../../src/serve/runtime/chip-traffic.js';
import {
  localRulesEvidenceHtml,
  localRulesSummary,
  rulesEvidenceHtml,
  rulesSummary,
} from '../../../src/serve/runtime/chip-rules-evidence.js';
import { useTempDirs } from '../../use-temp-dirs.js';

function request(): RequestEvent {
  return {
    kind: 'request', id: 'denied', at: 1, evalMs: 1, method: 'get', path: 'docs/a',
    auth: null, result: 'deny', reasons: [],
    rulesEvidence: {
      version: 'original', decision: 'DENY', scope: 'request', truncated: false, paths: [],
      rules: [{ expression: 'false', verdict: 'DENY', checks: [{ expression: 'false', parent: null, state: 'value', value: false }] }],
    },
  };
}

test('traffic snapshots evidence independently of later event mutation', () => {
  const event = request();
  const row = chipRequestFromEvent(event)!;
  event.rulesEvidence!.rules[0]!.expression = 'changed';
  expect(row.rulesEvidence!.rules[0]!.expression).toBe('false');
  expect(rulesSummary(row)).toBe('No applicable rule allowed this request.');
});

test('absence and bypass are explicit rather than inferred from identity', () => {
  const event = request();
  delete event.rulesEvidence;
  expect(rulesSummary(chipRequestFromEvent(event)!)).toContain('unavailable');
  event.rulesDisposition = { kind: 'bypassed', reason: 'admin' };
  expect(rulesSummary(chipRequestFromEvent(event)!)).toContain('bypassed');
});

test('partial evidence cannot imply a different final decision', () => {
  const event = request();
  event.result = 'allow';
  event.rulesEvidence!.decision = 'ALLOW';
  event.rulesEvidence!.truncated = true;
  const row = chipRequestFromEvent(event)!;
  expect(rulesSummary(row)).toBe('A rule allowed this request.');
  expect(rulesEvidenceHtml(row, text => text)).toContain('recording limit');
});

test('unsupported evaluations are not presented as successful requests', () => {
  const event = request();
  event.result = 'unsupported';
  event.rulesEvidence!.decision = 'UNSUPPORTED';
  const row = chipRequestFromEvent(event)!;
  expect(row.verdict).toBe('unsupported');
  expect(rulesSummary(row)).toContain('could not determine');
});

test('deciding checks include observed operands and full evaluation preserves helper context', () => {
  const event = request();
  event.rulesEvidence!.rules[0]!.checks = [
    { expression: 'version >= 0', parent: null, state: 'value', value: false },
    { expression: 'version', parent: 0, state: 'value', value: -1, helper: 'validVersion', binding: 'version' },
  ];
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html).toContain('-1');
  expect(html).toContain('<dt>Function</dt>');
  expect(html).toContain('validVersion()');
  expect(html).toContain('<dt>Variable</dt>');
});

test('unsupported proof is not erased by a false residual', () => {
  const event = request();
  event.rulesEvidence!.scope = 'query-residual';
  event.rulesEvidence!.rules[0]!.line = 5;
  event.rulesEvidence!.queryProof = { kind: 'unsupported-predicate', failures: [] };
  const row = chipRequestFromEvent(event)!;
  expect(rulesSummary(row)).toContain('unsupported');
  const html = rulesEvidenceHtml(row, text => text);
  expect(html).toContain('Residual line 5');
  expect(html).toContain('not the deployed rules');
});

test('primary checks are visible, with one secondary disclosure and no capture identifier', () => {
  const event = request();
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html.indexOf('Checks that failed')).toBeLessThan(html.indexOf('<details'));
  expect(html.match(/<details/g)).toHaveLength(1);
  expect(html).toContain('Rule details');
  expect(html).not.toContain('original');
  expect(html).not.toContain('scalar');
  expect(html).toContain('values shown can still be private');
});

test.each([
  { operator: '&&', value: false, explanation: 'Every check must pass. This earlier check failed' },
  { operator: '||', value: true, explanation: 'Only one check needs to pass. This earlier check passed' },
])('skipped checks explain the captured $operator result', ({ operator, value, explanation }) => {
  const event = request();
  event.rulesEvidence!.rules[0]!.checks = [
    { expression: `canEdit() ${operator} validBudget()`, parent: null, operator, state: 'value', value },
    { expression: 'canEdit()', parent: 0, state: 'value', value },
    { expression: 'validBudget()', parent: 0, state: 'skipped' },
  ];
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html).toContain(explanation);
  expect(html).toContain('<dt>Earlier check</dt>');
  expect(html).toContain('aria-label="Earlier check">canEdit()</code>');
});

test('incomplete skipped evidence does not invent a reason', () => {
  const event = request();
  event.rulesEvidence!.rules[0]!.checks = [
    { expression: 'validBudget()', parent: null, state: 'skipped' },
  ];
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html).toContain('The saved record does not explain why this check was skipped.');
  expect(html).not.toContain('<dt>Earlier check</dt>');
});

const makeHostedTempDir = useTempDirs('pyric-chip-deployed-rules-');

function makeMemoryPersistence(): HostedPersistence {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    seed: async () => false,
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  } as unknown as HostedPersistence;
}

async function waitForObservedEvents(
  frames: readonly BridgeMessage[],
  replyId: string,
  runtime: Awaited<ReturnType<typeof createHostedRuntime>>,
  clientSessionId: string,
): Promise<readonly SandboxEvent[]> {
  const replyDeadline = Date.now() + 3_000;
  while (Date.now() < replyDeadline) {
    const matched = frames.some(
      (frame) =>
        frame.type === 'worker-message-result' &&
        frame.message.t === 'res' &&
        (frame.message as { id?: string }).id === replyId,
    );
    if (matched) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  runtime.receive({
    type: 'worker-message',
    clientSessionId,
    message: { t: 'sub', subId: 'sub-events-1', target: 'events' },
  } as unknown as BridgeMessage);
  const evDeadline = Date.now() + 3_000;
  while (Date.now() < evDeadline) {
    const evFrame = frames.find(
      (frame) =>
        frame.type === 'worker-message-result' &&
        (frame.message as { t?: string; subId?: string }).t === 'event' &&
        (frame.message as { subId?: string }).subId === 'sub-events-1',
    );
    if (evFrame !== undefined && evFrame.type === 'worker-message-result') {
      return ((evFrame.message as { events?: SandboxEvent[] }).events ?? []);
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  return [];
}

function makeInitPayload(projectDir: string, rules: string | null): InitPayload {
  return {
    rules,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    projectKey: projectDir,
  };
}

test('hosted runtime attaches credential-free deployedRules detail on opted-in denials and chip renders source and drift', async () => {
  const projectDir = makeHostedTempDir();
  const deployedRules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /users/{uid} {',
    '      allow read: if request.auth != null && request.auth.uid == uid;',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const localRules = deployedRules.replace('request.auth != null && request.auth.uid == uid', 'true');
  writeFileSync(join(projectDir, 'firestore.rules'), localRules, 'utf8');

  const secret = 'hosted-secret-token-xyz';
  const routes: Record<string, () => Response> = {
    [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore`]: () =>
      new Response(JSON.stringify({ name: 'projects/demo-proj/releases/cloud.firestore', rulesetName: 'projects/demo-proj/rulesets/rs-chip' }), { status: 200 }),
    [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-chip`]: () =>
      new Response(JSON.stringify({ name: 'projects/demo-proj/rulesets/rs-chip', source: { files: [{ name: 'firestore.rules', content: deployedRules }] } }), { status: 200 }),
  };
  const live = createLiveHostState({
    configProjectId: 'demo-proj',
    configSource: undefined,
    optionName: '--project',
    warn: () => {},
    print: () => {},
    deployedRules: true,
    deployedRulesOptions: {
      tokenProvider: {
        async resolveToken() {
          return { ok: true, source: 'firebase-cli', token: secret, expiresAt: Date.now() + 60_000 };
        },
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        const handler = routes[String(input)];
        return handler === undefined ? new Response('not found', { status: 404 }) : handler();
      }) as typeof fetch,
    },
  });
  live.readRulesFiles(() =>
    rulesFilesOf(
      {
        firestoreRulesFiles: () => ['firestore.rules'],
        databaseRulesFiles: () => [],
        storageRulesFiles: () => [],
      },
      projectDir,
    ),
  );

  const frames: BridgeMessage[] = [];
  const runtime = await createHostedRuntime(
    makeInitPayload(projectDir, localRules),
    'http://127.0.0.1:3473',
    (msg) => frames.push(msg),
    projectDir,
    { persistence: makeMemoryPersistence(), observedSession: live.sessionData, record: false },
  );

  try {
    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'client-1',
      platform: 'node',
      message: {
        t: 'observe',
        id: 'obs-1',
        call: {
          service: 'firestore',
          method: 'getDoc',
          path: 'users/alice',
          at: 1_700_000_000_000,
          account: { uid: 'bob' },
          outcome: { status: 'error', code: 'permission-denied' },
        },
      },
    } as unknown as BridgeMessage);

    const events = await waitForObservedEvents(frames, 'obs-1', runtime, 'client-1');
    const opEvent = events.find((event) => event.kind === 'operation');
    expect(opEvent).toBeDefined();
    if (opEvent === undefined) return;
    expect(JSON.stringify(opEvent)).not.toContain(secret);

    const row = chipRequestFromEvent(opEvent);
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.deployedRules?.source).toBe('deployed');
    expect(row.deployedRules?.verdict).toBe('deny');
    expect(row.deployedRules?.drift?.drifted).toBe(true);
    expect(localRulesSummary(row)).toBe('Deployed rules did not allow this request. (drifted from local rules)');

    const html = localRulesEvidenceHtml(row, (value) => value.replace(/</g, '&lt;'));
    expect(html).toContain('<dt>Rules source</dt>');
    expect(html).toContain('Deployed rules ((default)), ruleset rs-chip');
    expect(html).toContain('<dt>Drift</dt>');
    expect(html).toContain('Line 5');

    const deployed = row.deployedRules;
    expect(deployed).toBeDefined();
    if (deployed === undefined) return;
    const disagreeRow = {
      ...row,
      deployedRules: {
        ...deployed,
        verdict: 'allow' as const,
        productionDisagrees: true,
      },
    };
    expect(localRulesEvidenceHtml(disagreeRow, (value) => value)).toContain(
      'Deployed rules evaluation (allow) disagrees with production denial.',
    );

    const fallbackRow = {
      ...row,
      deployedRules: {
        source: 'local' as const,
        fallbackReason: 'unauthenticated',
        fallbackMessage: 'Run <firebase login>.',
      },
    };
    expect(localRulesSummary(fallbackRow)).toContain('(local fallback; deployed rules unavailable)');
    const fallbackHtml = localRulesEvidenceHtml(fallbackRow, (value) => value.replace(/</g, '&lt;'));
    expect(fallbackHtml).toContain('Local fallback (Run &lt;firebase login>.)');
  } finally {
    await runtime.close();
  }
});

test('hosted runtime omits deployedRules detail and makes zero token calls when opt-in is off', async () => {
  const projectDir = makeHostedTempDir();
  let tokenCalls = 0;
  const live = createLiveHostState({
    configProjectId: 'demo-proj',
    configSource: undefined,
    optionName: '--project',
    warn: () => {},
    print: () => {},
    deployedRulesOptions: {
      tokenProvider: {
        async resolveToken() {
          tokenCalls += 1;
          return { ok: true, source: 'firebase-cli', token: 'unused', expiresAt: Date.now() + 60_000 };
        },
      },
    },
  });
  const frames: BridgeMessage[] = [];
  const runtime = await createHostedRuntime(
    makeInitPayload(projectDir, null),
    'http://127.0.0.1:3473',
    (msg) => frames.push(msg),
    projectDir,
    { persistence: makeMemoryPersistence(), observedSession: live.sessionData, record: false },
  );
  try {
    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'client-2',
      platform: 'node',
      message: {
        t: 'observe',
        id: 'obs-2',
        call: {
          service: 'firestore',
          method: 'getDoc',
          path: 'users/alice',
          at: 1_700_000_000_000,
          outcome: { status: 'error', code: 'permission-denied' },
        },
      },
    } as unknown as BridgeMessage);
    const events = await waitForObservedEvents(frames, 'obs-2', runtime, 'client-2');
    const opEvent = events.find((event) => event.kind === 'operation');
    expect(opEvent).toBeDefined();
    if (opEvent === undefined) return;
    const row = chipRequestFromEvent(opEvent);
    expect(row?.deployedRules).toBeUndefined();
    expect(tokenCalls).toBe(0);
  } finally {
    await runtime.close();
  }
});
