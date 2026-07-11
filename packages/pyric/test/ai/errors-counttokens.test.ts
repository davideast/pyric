/**
 * Red conformance suite: `countTokens` rows (ai#counttokens-*) and error
 * envelope rows (ai#error-*). One test per registry row id. Error facts
 * replay the five captured error observations; these claims are
 * value-deterministic in production and target the oracle-backed tier.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

let seam: AiSeam;

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

function freshAi(): any {
  const sandbox = seam.sandboxMod.initializeSandbox();
  return seam.ai.getAI(sandbox);
}

async function rejectionFrom(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('ai: countTokens', () => {
  const request = { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly one word.' }] }] };

  rowTest('ai#counttokens-envelope the countTokens key set is promptTokensDetails plus totalTokens', async () => {
    const facts = observedBehavior('ai-counttokens-envelope');
    const model = seam.ai.getGenerativeModel(freshAi(), { model: PROBE_MODEL });
    const result = await model.countTokens(request);
    expect(Object.keys(result).sort()).toEqual([...facts.topLevelKeySet].sort());
    expect(Number.isInteger(result.totalTokens)).toBe(true);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  rowTest('ai#counttokens-deterministic an identical payload returns an identical totalTokens', async () => {
    const facts = observedBehavior('ai-counttokens-envelope');
    expect(facts.deterministicAcrossTwoCalls).toBe(true);
    const model = seam.ai.getGenerativeModel(freshAi(), { model: PROBE_MODEL });
    const first = await model.countTokens(request);
    const second = await model.countTokens(request);
    expect(second.totalTokens).toBe(first.totalTokens);
  });
});

describe('ai: error envelopes', () => {
  rowTest('ai#error-unknown-model an unknown model fails 404 NOT_FOUND without details', async () => {
    const facts = observedBehavior('ai-error-unknown-model');
    expect(facts.httpStatus).toBe(404);
    expect(facts.errorStatus).toBe('NOT_FOUND');
    const model = seam.ai.getGenerativeModel(freshAi(), { model: 'not-a-real-model' });
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error.customErrorData?.status).toBe(facts.httpStatus);
    expect(String(error.message)).toContain('is not found for API version');
    expect(error.customErrorData?.errorDetails ?? []).toHaveLength(0);
  });

  rowTest('ai#error-retired-model a retired Gemini 1.5 model fails 404 with an ErrorInfo detail and a retirement message', async () => {
    const facts = observedBehavior('ai-error-retired-model');
    expect(facts.httpStatus).toBe(404);
    expect(facts.detailTypes).toContain('type.googleapis.com/google.rpc.ErrorInfo');
    const model = seam.ai.getGenerativeModel(freshAi(), { model: 'gemini-1.5-flash' });
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error.customErrorData?.status).toBe(facts.httpStatus);
    expect(String(error.message)).toContain('retired');
    const detailTypes = (error.customErrorData?.errorDetails ?? []).map((detail: any) => detail['@type']);
    expect(detailTypes).toContain('type.googleapis.com/google.rpc.ErrorInfo');
  });

  rowTest('ai#error-bad-api-key an invalid API key fails 400 INVALID_ARGUMENT, not 401', async () => {
    const facts = observedBehavior('ai-error-bad-api-key');
    expect(facts.httpStatus).toBe(400);
    expect(facts.errorStatus).toBe('INVALID_ARGUMENT');
    // Replay the captured envelope through the scripted error entry: the
    // sandbox has no key check of its own, the wire contract is the claim.
    const ai = freshAi();
    seam.scripting.script(ai, [
      {
        respond: {
          error: {
            httpStatus: facts.httpStatus,
            body: {
              error: {
                code: facts.errorCode,
                message: facts.messageText,
                status: facts.errorStatus,
                details: facts.detailTypes.map((type: string) => ({ '@type': type })),
              },
            },
          },
        },
      },
    ]);
    const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error.customErrorData?.status).toBe(400);
    expect(error.customErrorData?.status).not.toBe(401);
    expect(String(error.message)).toContain('API key not valid');
    const detailTypes = (error.customErrorData?.errorDetails ?? []).map((detail: any) => detail['@type']);
    // detailTypes is a set: ordering is not stable across cases.
    expect(new Set(detailTypes)).toEqual(new Set(facts.detailTypes));
  });

  rowTest('ai#error-empty-contents an empty contents array fails 400 INVALID_ARGUMENT naming contents', async () => {
    const facts = observedBehavior('ai-error-empty-contents');
    expect(facts.httpStatus).toBe(400);
    const model = seam.ai.getGenerativeModel(freshAi(), { model: PROBE_MODEL });
    const error = await rejectionFrom(model.generateContent({ contents: [] }));
    expect(error.customErrorData?.status).toBe(facts.httpStatus);
    expect(String(error.message)).toContain('contents is not specified');
  });

  rowTest('ai#error-bad-role an invalid role fails 400 listing the production role vocabulary', async () => {
    const facts = observedBehavior('ai-error-bad-role');
    expect(facts.httpStatus).toBe(400);
    const model = seam.ai.getGenerativeModel(freshAi(), { model: PROBE_MODEL });
    const error = await rejectionFrom(
      model.generateContent({ contents: [{ role: 'banana', parts: [{ text: 'hello' }] }] }),
    );
    expect(error.customErrorData?.status).toBe(facts.httpStatus);
    const message = String(error.message);
    for (const role of ['SYSTEM', 'SYSTEM_1', 'USER', 'ASSISTANT', 'DEVELOPER', 'CONTEXT', 'USER_CONTEXT', 'MODEL']) {
      expect(message).toContain(role);
    }
  });

  rowTest('ai#error-aierror-shape HTTP failures surface as AIError with customErrorData', async () => {
    const facts = observedBehavior('ai-error-bad-api-key');
    const model = seam.ai.getGenerativeModel(freshAi(), { model: 'not-a-real-model' });
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error).toBeInstanceOf(seam.ai.AIError);
    expect(typeof error.code).toBe('string');
    expect(Object.values(seam.ai.AIErrorCode)).toContain(error.code.replace(/^.*\//, ''));
    expect(error.customErrorData).toBeDefined();
    expect(typeof error.customErrorData.status).toBe('number');
    // The captured envelope key set is code, details, message, status; the
    // client class carries the HTTP status and details through.
    expect(facts.errorKeySet).toContain('status');
  });

  rowTest('ai#error-code-vocabulary AIErrorCode exposes the 14 documented codes', () => {
    const expected = [
      'error',
      'request-error',
      'response-error',
      'fetch-error',
      'session-closed',
      'invalid-content',
      'api-not-enabled',
      'invalid-schema',
      'no-api-key',
      'no-app-id',
      'no-model',
      'no-project-id',
      'parse-failed',
      'unsupported',
    ];
    expect(Object.values(seam.ai.AIErrorCode).sort()).toEqual([...expected].sort());
  });
});
