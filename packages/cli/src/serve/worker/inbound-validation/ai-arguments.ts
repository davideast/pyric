import {
  isMessageRecord,
  requireOptionalString,
  requireRecord,
  requireShape,
  requireString,
} from './fields.js';

/** An App Check claim is absent (a handle with no app) or a record whose token is a string or null. */
function assertAiAppCheck(appCheck: unknown): void {
  const hasNoClaim = appCheck === undefined;
  if (hasNoClaim) return;
  requireRecord(appCheck, 'appCheck');
  const token = appCheck.token;
  const hasTokenShape = token === null || typeof token === 'string';
  requireShape(hasTokenShape, 'appCheck.token');
  const runtime = appCheck.runtime;
  if (runtime !== undefined) {
    const validRuntime = runtime === 'browser' || runtime === 'server';
    requireShape(validRuntime, 'appCheck.runtime');
  }
  requireOptionalString(appCheck.projectId, 'appCheck.projectId');
  requireOptionalString(appCheck.appId, 'appCheck.appId');
}

/** Unary and streaming AI requests share the same adapter-owned wire fields. */
export function assertAiArguments(message: Record<string, unknown>): void {
  requireString(message.model, 'model');
  requireRecord(message.request, 'request');
  assertAiAppCheck(message.appCheck);
  const engine = message.engine;
  const hasNoEngine = engine === undefined;
  if (hasNoEngine) return;
  requireRecord(engine, 'engine');
  const hasSupportedEngine =
    engine.kind === 'scripted' || engine.kind === 'openai' || engine.kind === 'gemini';
  requireShape(hasSupportedEngine, 'engine.kind');
  switch (engine.kind) {
    case 'scripted': {
      const script = engine.script;
      const hasScript = script !== undefined;
      if (hasScript) {
        const isScript = Array.isArray(script) && script.every(isMessageRecord);
        requireShape(isScript, 'engine.script');
      }
      return;
    }
    case 'openai': {
      requireOptionalString(engine.baseUrl, 'engine.baseUrl');
      requireOptionalString(engine.model, 'engine.model');
      const modelMap = engine.modelMap;
      const hasModelMap = modelMap !== undefined;
      if (hasModelMap) {
        requireRecord(modelMap, 'engine.modelMap');
        const hasStringModels = Object.values(modelMap).every(
          (model) => typeof model === 'string',
        );
        requireShape(hasStringModels, 'engine.modelMap');
      }
      return;
    }
    case 'gemini':
      requireOptionalString(engine.baseUrl, 'engine.baseUrl');
      requireOptionalString(engine.apiKey, 'engine.apiKey');
      return;
  }
}
