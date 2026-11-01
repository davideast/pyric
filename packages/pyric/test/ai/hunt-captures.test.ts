/**
 * Replays the App Check and AI Logic hunt's `ai-request-edge-` captures
 * through pyric/ai on the zero-config scripted engine. Each capture records
 * one raw generateContent request (its body is in the observation) and
 * production's answer; the replay sends the same request through the SDK
 * surface an app uses and compares the outcome and HTTP status.
 *
 * Each key pyric gets wrong is pinned under its finding with both answers
 * (replay-comparison.ts): the test stays green today and fails when either
 * side moves. The fix for a finding deletes its pin.
 */
import { describe, expect, test } from 'bun:test';
import { getAI, getGenerativeModel, type GenerateContentRequest } from 'pyric/ai';
import { initializeSandbox } from 'pyric/sandbox';
import { replayMismatches, type Behavior, type Pin } from '../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import { observedBehavior } from './support.ts';

interface EdgeRequest {
  model: string;
  body: { contents: { role?: string; parts: { text: string }[] }[]; systemInstruction?: string };
}

/** The outcome both sides are compared on: answered or refused, and the HTTP status. */
type Outcome = { outcome: 'answered' | 'refused'; httpStatus: number };

function productionOutcome(name: string): Outcome & { request: EdgeRequest } {
  const facts = observedBehavior(name) as { httpStatus: number; request: EdgeRequest };
  const answered = facts.httpStatus === 200;
  return { outcome: answered ? 'answered' : 'refused', httpStatus: facts.httpStatus, request: facts.request };
}

async function pyricOutcome(call: () => Promise<unknown>): Promise<Outcome> {
  try {
    await call();
    return { outcome: 'answered', httpStatus: 200 };
  } catch (error) {
    const status = (error as { customErrorData?: { status?: number } }).customErrorData?.status;
    return { outcome: 'refused', httpStatus: status ?? 0 };
  }
}

const model = (name: string) => getGenerativeModel(getAI(initializeSandbox()), { model: name });

function compare(production: Outcome, pyric: Outcome, pins: Pin[]): string[] {
  const { outcome, httpStatus } = production;
  return replayMismatches({ production: { outcome, httpStatus } as Behavior, pyric: pyric as unknown as Behavior, pins });
}

const pinsFor = (finding: string, production: Outcome, pyric: Outcome): Pin[] => [
  { key: 'outcome', finding, production: production.outcome, pyric: pyric.outcome },
  { key: 'httpStatus', finding, production: production.httpStatus, pyric: pyric.httpStatus },
];
const ANSWERED: Outcome = { outcome: 'answered', httpStatus: 200 };

describe('ai-request-edge replays', () => {
  test('ai-request-edge-roleless-contents: contents with no role (AI-21)', async () => {
    const production = productionOutcome('ai-request-edge-roleless-contents');
    const request = production.request.body as unknown as GenerateContentRequest;
    const pyric = await pyricOutcome(() => model(production.request.model).generateContent(request));
    // Pyric refuses with "Role '' is not supported"; production answers the turn.
    expect(compare(production, pyric, pinsFor('AI-21', ANSWERED, { outcome: 'refused', httpStatus: 400 }))).toEqual([]);
  });

  test('ai-request-edge-string-system-instruction: startChat with a string systemInstruction (AI-22)', async () => {
    const production = productionOutcome('ai-request-edge-string-system-instruction');
    const { body } = production.request;
    const systemInstruction = body.systemInstruction ?? '';
    const prompt = body.contents[0]?.parts[0]?.text ?? '';
    // The real SDK's startChat sends this string as a top-level systemInstruction, the request the capture sent.
    const pyric = await pyricOutcome(() => model(production.request.model).startChat({ systemInstruction }).sendMessage(prompt));
    expect(compare(production, pyric, pinsFor('AI-22', { outcome: 'refused', httpStatus: 400 }, ANSWERED))).toEqual([]);
  });

  test('ai-request-edge-model-gemini-pro: the model name gemini-pro (AI-23)', async () => {
    const production = productionOutcome('ai-request-edge-model-gemini-pro');
    const request = production.request.body as unknown as GenerateContentRequest;
    const pyric = await pyricOutcome(() => model(production.request.model).generateContent(request));
    expect(compare(production, pyric, pinsFor('AI-23', { outcome: 'refused', httpStatus: 404 }, ANSWERED))).toEqual([]);
  });
});
