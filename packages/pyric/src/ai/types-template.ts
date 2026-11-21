/**
 * Public TypeScript contracts for Firebase AI Server Prompt Templates and
 * Attribution types owned by `pyric/ai`.
 *
 * `TemplateGenerativeModel` is exported only in the TypeScript type namespace
 * so the deferred runtime disposition in `packages/conformance/surfaces/ai.json`
 * remains accurate.
 */
import type { RequestOptions, StartChatParams } from './models.js';
import type { SingleRequestOptions } from './sandbox-plane.js';
import type {
  Content,
  EnhancedGenerateContentResponse,
  ObjectSchemaRequest,
  Part,
  RetrievalConfig,
  SchemaInterface,
} from './types.js';

interface SchemaInstance extends SchemaInterface {
  nullable: boolean;
}

interface ObjectSchemaInstance extends SchemaInstance {
  properties: Record<string, SchemaInstance>;
  optionalProperties: string[];
}

interface TemplateGenerateContentResult {
  response: EnhancedGenerateContentResponse;
}

interface TemplateGenerateContentStreamResult {
  stream: AsyncGenerator<EnhancedGenerateContentResponse>;
  response: Promise<EnhancedGenerateContentResponse>;
}

export interface RetrievedContextAttribution {
  uri: string;
  title: string;
}

export interface WebAttribution {
  uri: string;
  title: string;
}

export interface TemplateFunctionDeclaration {
  name: string;
  description?: never;
  parameters?: ObjectSchemaInstance | ObjectSchemaRequest;
  functionReference?: Function;
}

export interface TemplateFunctionDeclarationsTool {
  functionDeclarations?: TemplateFunctionDeclaration[];
}

export type TemplateTool = TemplateFunctionDeclarationsTool;

export interface TemplateToolConfig {
  retrievalConfig?: RetrievalConfig;
}

export interface StartTemplateChatParams extends Omit<StartChatParams, 'tools'> {
  templateId: string;
  templateVariables?: Record<string, unknown>;
  tools?: TemplateTool[];
}

export interface TemplateChatSession {
  params: StartTemplateChatParams;
  requestOptions?: RequestOptions;
  sendMessage(
    request: string | Array<string | Part>,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<TemplateGenerateContentResult>;
  sendMessageStream(
    request: string | Array<string | Part>,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<TemplateGenerateContentStreamResult>;
  getHistory(): Promise<Content[]>;
}

export interface TemplateGenerativeModel {
  requestOptions?: RequestOptions;
  generateContent(
    templateId: string,
    templateVariables: Record<string, unknown>,
    singleRequestOptions?: SingleRequestOptions,
    templateToolConfig?: TemplateToolConfig,
  ): Promise<TemplateGenerateContentResult>;
  generateContentStream(
    templateId: string,
    templateVariables: Record<string, unknown>,
    singleRequestOptions?: SingleRequestOptions,
    templateToolConfig?: TemplateToolConfig,
  ): Promise<TemplateGenerateContentStreamResult>;
  startChat(params: StartTemplateChatParams): TemplateChatSession;
}
