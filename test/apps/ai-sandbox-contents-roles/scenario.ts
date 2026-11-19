// In the default sandbox AI mode, `contents` turns under role `assistant` or
// with no `role` (`ai-request-edge-roleless-contents`), as well as `startChat`
// with a string `systemInstruction` (`@firebase/ai` 2.16.0), succeed; a turn
// under role `system` is refused with production's 400 INVALID_ARGUMENT text
// (`ai-contents-role-system`); and `gemini-pro` is refused with production's
// 404 NOT_FOUND text (`ai-request-edge-model-gemini-pro`) while emitting
// `request_rejected` to the dev-server terminal. Runs in Chromium on both the
// SharedWorker sandbox and the Node host.
import assert from 'node:assert/strict';
import { scenario, type App } from '../driver.ts';

const SYSTEM_REFUSAL = "Role 'system' is not supported. Please use a valid role: MODEL, USER.";
const GEMINI_PRO_REFUSAL = 'models/gemini-pro is not found for API version v1main';

interface Outcome {
  ok: boolean;
  text?: string;
  status?: number | null;
  error?: string;
}

interface SchemaBuildersOutcome extends Outcome {
  objectJson?: Record<string, unknown>;
  enumJson?: Record<string, unknown>;
  anyOfJson?: Record<string, unknown>;
  isAnyOfSchema?: boolean;
  emptyAnyOfGuard?: {
    isAIError: boolean;
    isFirebaseError: boolean;
    code: string | null;
  };
}

interface ChatErrorsAbortOutcome {
  abortContentName: string | null;
  abortContentIsAIError: boolean;
  abortStringName: string | null;
  isChatSession: boolean;
  defaultHistoryLength: number;
  seededRoles: string[];
  emptyPartsCode: string | null;
  emptyPartsIsFirebaseError: boolean;
  modelFirstCode: string | null;
  possibleRoles: string[];
  errorCodeCount: number;
  constructedError: {
    isAIError: boolean;
    isFirebaseError: boolean;
    code: string;
    status: number | null;
    reason: string | null;
  };
}

interface Roles {
  assistant: Outcome;
  system: Outcome;
  roleless: Outcome;
  chatStringSystem: Outcome;
  geminiPro: Outcome;
  schemaBuilders: SchemaBuildersOutcome;
  chatErrorsAbort: ChatErrorsAbortOutcome;
}

declare function runRoles(): Promise<Roles>;

function assertRoles(roles: Roles): void {
  assert.equal(roles.assistant.ok, true, `assistant turn: ${JSON.stringify(roles.assistant)}`);
  assert.ok(roles.assistant.text, 'the assistant turn got an empty reply');

  assert.equal(roles.system.ok, false, `system turn: ${JSON.stringify(roles.system)}`);
  assert.ok(roles.system.error?.includes(SYSTEM_REFUSAL), `system turn error: ${roles.system.error}`);
  assert.equal(roles.system.status, 400);

  assert.equal(roles.roleless.ok, true, `roleless turn: ${JSON.stringify(roles.roleless)}`);
  assert.ok(roles.roleless.text, 'the roleless turn got an empty reply');

  assert.equal(
    roles.chatStringSystem.ok,
    true,
    `chatStringSystem turn: ${JSON.stringify(roles.chatStringSystem)}`,
  );
  assert.ok(roles.chatStringSystem.text, 'the chatStringSystem turn got an empty reply');

  assert.equal(roles.geminiPro.ok, false, `geminiPro turn: ${JSON.stringify(roles.geminiPro)}`);
  assert.ok(
    roles.geminiPro.error?.includes(GEMINI_PRO_REFUSAL),
    `geminiPro error: ${roles.geminiPro.error}`,
  );
  assert.equal(roles.geminiPro.status, 404);

  assert.equal(
    roles.schemaBuilders.ok,
    true,
    `schemaBuilders: ${JSON.stringify(roles.schemaBuilders)}`,
  );
  assert.deepEqual(roles.schemaBuilders.objectJson, {
    type: 'object',
    properties: {
      city: { type: 'string', nullable: false },
      days: { type: 'integer', nullable: false },
    },
    nullable: false,
    required: ['city'],
  });
  assert.deepEqual(roles.schemaBuilders.enumJson, {
    type: 'string',
    format: 'enum',
    enum: ['red', 'green', 'blue'],
    nullable: false,
  });
  assert.equal(roles.schemaBuilders.isAnyOfSchema, true);
  assert.deepEqual(roles.schemaBuilders.anyOfJson, {
    anyOf: [
      { type: 'string', nullable: false },
      { type: 'integer', nullable: false },
    ],
    nullable: false,
  });
  assert.deepEqual(roles.schemaBuilders.emptyAnyOfGuard, {
    isAIError: true,
    isFirebaseError: true,
    code: 'invalid-schema',
  });

  assert.deepEqual(roles.chatErrorsAbort, {
    abortContentName: 'AbortError',
    abortContentIsAIError: false,
    abortStringName: 'AbortError',
    isChatSession: true,
    defaultHistoryLength: 0,
    seededRoles: ['user', 'model', 'function'],
    emptyPartsCode: 'invalid-content',
    emptyPartsIsFirebaseError: true,
    modelFirstCode: 'invalid-content',
    possibleRoles: ['user', 'model', 'function', 'system'],
    errorCodeCount: 14,
    constructedError: {
      isAIError: true,
      isFirebaseError: true,
      code: 'fetch-error',
      status: 400,
      reason: 'API_KEY_INVALID',
    },
  });
}

async function checkPlane(app: App, name: string, env: Record<string, string>): Promise<void> {
  const host = await app.devServer({ name, env });
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'runRoles' in window);
  const since = host.process.mark();
  assertRoles(await page.evaluate(() => runRoles()));
  await host.process.waitForLog(
    new RegExp(`${SYSTEM_REFUSAL}\\s+model: .*\\s+INVALID_ARGUMENT \\(400\\)`),
    { since, timeoutMs: 10_000 },
  );
  await host.process.waitForLog(
    new RegExp(`${GEMINI_PRO_REFUSAL}.*\\s+model: .*\\s+NOT_FOUND \\(404\\)`),
    { since, timeoutMs: 10_000 },
  );
  const recentLog = host.process.output.slice(since);
  assert.doesNotMatch(recentLog, /Role 'assistant' is not supported/);
  assert.doesNotMatch(recentLog, /Role '' is not supported/);
  assert.doesNotMatch(recentLog, /Invalid value at 'system_instruction'/);
  await host.process.stop();
}

export default scenario(async (app) => {
  const external: string[] = [];
  await app.step('record any request that leaves for another host', async () => {
    const context = await app.browser();
    await context.route(
      (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
      (route) => {
        external.push(route.request().url());
        return route.abort();
      },
    );
  });

  await app.step('the SharedWorker sandbox enforces AI role, ChatSession, and model request edges', () =>
    checkPlane(app, 'SharedWorker dev server', {}),
  );

  await app.step('the Node host enforces AI role, ChatSession, and model request edges', () =>
    checkPlane(app, 'Node host dev server', { SCENARIO_HOSTED: '1' }),
  );

  await app.step('no request left for Google or Firebase', () => {
    assert.deepEqual(external, []);
  });
});
