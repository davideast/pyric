/**
 * Request formatting for `pyric/ai`, ported from the installed
 * `@firebase/ai@2.12.0` request-helpers / chat-session-helpers so string
 * prompts, part arrays, and `{ contents }` objects all normalize exactly the
 * way the SDK normalizes them before hitting the wire:
 *
 *   - `formatNewContent`: a string or Part[] becomes one `user` turn, or one
 *     `function` turn when every part is a functionResponse (mixing throws
 *     `invalid-content`, same as upstream).
 *   - `formatSystemInstruction`: string | Part | Content -> Content with role
 *     `system`.
 *   - `formatGenerateContentInput`: the entry point request union.
 *   - `validateChatHistory`: the upstream role/part/ordering validation run
 *     on `startChat({ history })`.
 */

import { AIError, AIErrorCode } from './errors.js';
import { POSSIBLE_ROLES, type Role } from './enums.js';

/** A single content part (structural; upstream `Part` union member shape). */
export interface PartShape {
  type?: string;
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string; parts?: PartShape[] };
  thought?: boolean;
  thoughtSignature?: string;
  speechMetadata?: { speaker?: string; style?: string };
  videoMetadata?: { startOffset: string; endOffset: string };
  executableCode?: unknown;
  codeExecutionResult?: unknown;
}

export function assignPartType(part: PartShape): PartShape {
  if ('type' in part && typeof part.type === 'string' && part.type.length > 0) {
    return part;
  }
  if (part.text !== undefined) {
    return { type: 'text', ...part };
  }
  if (part.inlineData !== undefined) {
    return { type: 'inlineData', ...part };
  }
  if (part.functionCall !== undefined) {
    return { type: 'functionCall', ...part };
  }
  if (part.functionResponse !== undefined) {
    return { type: 'functionResponse', ...part };
  }
  if (part.fileData !== undefined) {
    return { type: 'fileData', ...part };
  }
  if (part.executableCode !== undefined) {
    return { type: 'executableCode', ...part };
  }
  if (part.codeExecutionResult !== undefined) {
    return { type: 'codeExecutionResult', ...part };
  }
  return part;
}

function stripPartType(part: PartShape): PartShape {
  let wirePart: PartShape = part;
  if ('type' in part) {
    const { type: _type, ...rest } = part;
    wirePart = rest;
  }
  if (wirePart.functionResponse && Array.isArray(wirePart.functionResponse.parts)) {
    wirePart = {
      ...wirePart,
      functionResponse: {
        ...wirePart.functionResponse,
        parts: wirePart.functionResponse.parts.map(stripPartType),
      },
    };
  }
  return wirePart;
}

export function cleanRequestForWire(request: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...request };
  if (Array.isArray(request.contents)) {
    cleaned.contents = (request.contents as ContentShape[]).map((content) => {
      if (!Array.isArray(content.parts)) return content;
      return {
        ...content,
        parts: content.parts.map(stripPartType),
      };
    });
  }
  const sys = request.systemInstruction as { role?: string; parts?: PartShape[] } | undefined;
  if (sys && typeof sys === 'object' && Array.isArray(sys.parts)) {
    cleaned.systemInstruction = {
      ...sys,
      parts: sys.parts.map(stripPartType),
    };
  }
  return cleaned;
}

/** Content: a role plus its parts. */
export interface ContentShape {
  role: string;
  parts: PartShape[];
}

export type RequestInput = string | Array<string | PartShape>;

export interface GenerateContentRequestShape {
  contents: ContentShape[];
  systemInstruction?: ContentShape | { parts: PartShape[] };
  tools?: unknown[];
  toolConfig?: unknown;
  generationConfig?: Record<string, unknown>;
  safetySettings?: unknown[];
  [key: string]: unknown;
}

export function formatSystemInstruction(
  input?: string | PartShape | ContentShape,
): ContentShape | undefined {
  if (input == null) {
    return undefined;
  } else if (typeof input === 'string') {
    return { role: 'system', parts: [{ text: input }] };
  } else if ((input as PartShape).text) {
    return { role: 'system', parts: [input as PartShape] };
  } else if ((input as ContentShape).parts) {
    const content = input as ContentShape;
    if (!content.role) {
      return { role: 'system', parts: content.parts };
    }
    return content;
  }
  return undefined;
}

export function formatNewContent(request: RequestInput): ContentShape {
  let newParts: PartShape[] = [];
  if (typeof request === 'string') {
    newParts = [{ text: request }];
  } else {
    for (const partOrString of request) {
      if (typeof partOrString === 'string') {
        newParts.push({ text: partOrString });
      } else {
        newParts.push(partOrString);
      }
    }
  }
  return assignRoleToParts(newParts);
}

/**
 * FunctionResponse parts require role `function`; everything else is
 * `user`. Mixing the two in one message throws, exactly like upstream.
 */
function assignRoleToParts(parts: PartShape[]): ContentShape {
  const userContent: ContentShape = { role: 'user', parts: [] };
  const functionContent: ContentShape = { role: 'function', parts: [] };
  let hasUserContent = false;
  let hasFunctionContent = false;
  for (const part of parts) {
    if ('functionResponse' in part && part.functionResponse) {
      functionContent.parts.push(part);
      hasFunctionContent = true;
    } else {
      userContent.parts.push(part);
      hasUserContent = true;
    }
  }
  if (hasUserContent && hasFunctionContent) {
    throw new AIError(
      AIErrorCode.INVALID_CONTENT,
      'Within a single message, FunctionResponse cannot be mixed with other type of Part in the request for sending chat message.',
    );
  }
  if (!hasUserContent && !hasFunctionContent) {
    throw new AIError(AIErrorCode.INVALID_CONTENT, 'No Content is provided for sending chat message.');
  }
  return hasUserContent ? userContent : functionContent;
}

export function formatGenerateContentInput(
  params: RequestInput | GenerateContentRequestShape,
): GenerateContentRequestShape {
  let formattedRequest: GenerateContentRequestShape;
  if ((params as GenerateContentRequestShape).contents) {
    formattedRequest = params as GenerateContentRequestShape;
  } else {
    const content = formatNewContent(params as RequestInput);
    formattedRequest = { contents: [content] };
  }
  if ((params as GenerateContentRequestShape).systemInstruction) {
    formattedRequest.systemInstruction = formatSystemInstruction(
      (params as GenerateContentRequestShape).systemInstruction as
        | string
        | PartShape
        | ContentShape,
    );
  }
  return formattedRequest;
}

// -- Chat history validation (upstream chat-session-helpers) ----------------

const VALID_PART_FIELDS = [
  'text',
  'inlineData',
  'functionCall',
  'functionResponse',
  'thought',
  'thoughtSignature',
  'fileData',
  'executableCode',
  'codeExecutionResult',
] as const;

const PART_VALUE_KEYS = [
  'text',
  'inlineData',
  'functionCall',
  'functionResponse',
  'fileData',
  'executableCode',
  'codeExecutionResult',
] as const;

const VALID_PARTS_PER_ROLE: Record<Role, string[]> = {
  user: ['text', 'inlineData', 'fileData'],
  function: ['functionResponse'],
  model: ['text', 'functionCall', 'thought', 'thoughtSignature', 'executableCode', 'codeExecutionResult'],
  // System instructions shouldn't be in history anyway.
  system: ['text'],
};

const VALID_PREVIOUS_CONTENT_ROLES: Record<Role, string[]> = {
  user: ['model'],
  function: ['model'],
  model: ['user', 'function'],
  system: [],
};

export function validateChatHistory(history: ContentShape[]): void {
  let prevContent: ContentShape | null = null;
  for (const currContent of history) {
    const { role, parts } = currContent;
    if (!prevContent && role !== 'user') {
      throw new AIError(
        AIErrorCode.INVALID_CONTENT,
        `First Content should be with role 'user', got ${role}`,
      );
    }
    if (!(POSSIBLE_ROLES as readonly string[]).includes(role)) {
      throw new AIError(
        AIErrorCode.INVALID_CONTENT,
        `Each item should include role field. Got ${role} but valid roles are: ${JSON.stringify(POSSIBLE_ROLES)}`,
      );
    }
    if (!Array.isArray(parts)) {
      throw new AIError(
        AIErrorCode.INVALID_CONTENT,
        `Content should have 'parts' property with an array of Parts`,
      );
    }
    if (parts.length === 0) {
      throw new AIError(AIErrorCode.INVALID_CONTENT, `Each Content should have at least one part`);
    }
    const countFields: Record<string, number> = {};
    for (const field of VALID_PART_FIELDS) countFields[field] = 0;
    for (const part of parts) {
      if (typeof part.type === 'string' && part.type in countFields) {
        countFields[part.type] = (countFields[part.type] ?? 0) + 1;
      } else {
        for (const field of PART_VALUE_KEYS) {
          if (field in part) {
            countFields[field] = (countFields[field] ?? 0) + 1;
          }
        }
      }
      if ('thought' in part && part.thought) {
        countFields.thought = (countFields.thought ?? 0) + 1;
      }
      if ('thoughtSignature' in part && part.thoughtSignature) {
        countFields.thoughtSignature = (countFields.thoughtSignature ?? 0) + 1;
      }
    }
    const validParts = VALID_PARTS_PER_ROLE[role as Role];
    for (const field of VALID_PART_FIELDS) {
      if (!validParts.includes(field) && (countFields[field] ?? 0) > 0) {
        throw new AIError(
          AIErrorCode.INVALID_CONTENT,
          `Content with role '${role}' can't contain '${field}' part`,
        );
      }
    }
    if (prevContent) {
      const validPreviousContentRoles = VALID_PREVIOUS_CONTENT_ROLES[role as Role];
      if (!validPreviousContentRoles.includes(prevContent.role)) {
        throw new AIError(
          AIErrorCode.INVALID_CONTENT,
          `Content with role '${role}' can't follow '${prevContent.role}'. Valid previous roles: ${JSON.stringify(VALID_PREVIOUS_CONTENT_ROLES)}`,
        );
      }
    }
    prevContent = currContent;
  }
}
