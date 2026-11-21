/**
 * Compile-time parity against `firebase/ai` for the 9 Server Prompt Template
 * and Attribution public TypeScript exports in
 * `packages/pyric/src/ai/types-template.ts`.
 */
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import type * as Firebase from 'firebase/ai';
import {
  Schema,
  type RetrievedContextAttribution,
  type StartTemplateChatParams,
  type TemplateChatSession,
  type TemplateFunctionDeclaration,
  type TemplateFunctionDeclarationsTool,
  type TemplateGenerativeModel,
  type TemplateTool,
  type TemplateToolConfig,
  type WebAttribution,
} from '../../src/ai/index.js';
import type * as TemplateTypesModule from '../../src/ai/types-template.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type PublicShape<T> = { [K in keyof T]: T[K] };

type Parity = {
  RetrievedContextAttribution: Same<
    RetrievedContextAttribution,
    Firebase.RetrievedContextAttribution
  >;
  StartTemplateChatParams: Same<StartTemplateChatParams, Firebase.StartTemplateChatParams>;
  TemplateChatSession: Same<TemplateChatSession, Firebase.TemplateChatSession>;
  TemplateFunctionDeclaration: Same<
    TemplateFunctionDeclaration,
    Firebase.TemplateFunctionDeclaration
  >;
  TemplateFunctionDeclarationsTool: Same<
    TemplateFunctionDeclarationsTool,
    Firebase.TemplateFunctionDeclarationsTool
  >;
  TemplateGenerativeModel: Same<
    TemplateGenerativeModel,
    PublicShape<Firebase.TemplateGenerativeModel>
  >;
  TemplateTool: Same<TemplateTool, Firebase.TemplateTool>;
  TemplateToolConfig: Same<TemplateToolConfig, Firebase.TemplateToolConfig>;
  WebAttribution: Same<WebAttribution, Firebase.WebAttribution>;
  ModuleWebAttribution: Same<TemplateTypesModule.WebAttribution, Firebase.WebAttribution>;
};

const parityChecks: { [K in keyof Parity]: true } = {
  RetrievedContextAttribution: true,
  StartTemplateChatParams: true,
  TemplateChatSession: true,
  TemplateFunctionDeclaration: true,
  TemplateFunctionDeclarationsTool: true,
  TemplateGenerativeModel: true,
  TemplateTool: true,
  TemplateToolConfig: true,
  WebAttribution: true,
  ModuleWebAttribution: true,
};

describe('pyric/ai template and attribution TypeScript parity', () => {
  it('verifies bidirectional assignability against firebase/ai with zero diagnostics', () => {
    expect(parityChecks.TemplateGenerativeModel).toBe(true);
    const program = ts.createProgram([import.meta.path], {
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(diagnostics).toEqual([]);
  }, 30_000);

  it('supports strongly typed TemplateFunctionDeclaration, StartTemplateChatParams, and attribution shapes', () => {
    const fnDecl: TemplateFunctionDeclaration = {
      name: 'lookupOrder',
      parameters: Schema.object({
        properties: {
          orderId: Schema.string(),
        },
      }),
    };
    const tool: TemplateTool = {
      functionDeclarations: [fnDecl],
    };
    const toolConfig: TemplateToolConfig = {
      retrievalConfig: { languageCode: 'en-US' },
    };
    const chatParams: StartTemplateChatParams = {
      templateId: 'support-assistant-v1',
      templateVariables: { customerTier: 'pro' },
      tools: [tool],
      toolConfig,
    };
    const webAttr: WebAttribution = {
      uri: 'https://example.com/guide',
      title: 'Product Guide',
    };
    const ctxAttr: RetrievedContextAttribution = {
      uri: 'gs://docs-bucket/manual.pdf',
      title: 'Reference Manual',
    };

    expect(chatParams.templateId).toBe('support-assistant-v1');
    expect(webAttr.title).toBe('Product Guide');
    expect(ctxAttr.uri).toBe('gs://docs-bucket/manual.pdf');
  });
});
