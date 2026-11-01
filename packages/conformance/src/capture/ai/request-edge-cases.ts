/**
 * The three AI Logic generateContent request edges the request-edge runner
 * sends, each in the installed @firebase/ai request body shape. Each case is
 * exactly one request; the runner sends nothing else.
 */

export const REQUEST_EDGE_MODEL = 'gemini-flash-lite-latest';

const PROMPT = 'Reply with one word: pong';
const userTurn = (text: string) => ({ role: 'user', parts: [{ text }] });

export interface RequestEdgeCase {
  name: string;
  model: string;
  body: Record<string, unknown>;
  description: string;
}

export const REQUEST_EDGE_CASES: RequestEdgeCase[] = [
  {
    name: 'ai-request-edge-roleless-contents',
    model: REQUEST_EDGE_MODEL,
    body: { contents: [{ parts: [{ text: PROMPT }] }] },
    description:
      'generateContent with one contents entry that has parts and no role. Records whether production accepts it and, on success, the candidate finish reason, content role and part key sets. Generated text is never a claim and is not stored.',
  },
  {
    name: 'ai-request-edge-string-system-instruction',
    model: REQUEST_EDGE_MODEL,
    body: { contents: [userTurn(PROMPT)], systemInstruction: 'Answer in lowercase.' },
    description:
      'generateContent with systemInstruction sent as a top-level string instead of a Content object. Records the HTTP status and error envelope production returns.',
  },
  {
    name: 'ai-request-edge-model-gemini-pro',
    model: 'gemini-pro',
    body: { contents: [userTurn(PROMPT)] },
    description:
      'generateContent addressed to the model name gemini-pro. Records the HTTP status and error envelope production returns for that model name.',
  },
];
