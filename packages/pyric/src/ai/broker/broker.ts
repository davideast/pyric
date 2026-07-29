/**
 * The sandbox AI broker — the ONE in-process Gemini-wire model every plane
 * consumes (house pattern: the messaging broker):
 *
 *   - the client mirror (`pyric/ai`, next stage) calls generateContent /
 *     streamGenerateContent / countTokens exactly like `rtdb.*` / `auth.*`
 *     will over the worker protocol (cdd-deltas #98.3);
 *   - Pyric Studio & tracing consume the typed `service_mutation` events the
 *     broker emits onto the sandbox's unified `onEvent` stream;
 *   - answering is delegated through ONE seam ({@link AnswerEngine},
 *     cdd-deltas #97): `scripted` (default, zero-I/O) or `openai`.
 *
 * The broker validates requests LIKE PRODUCTION does — before any engine
 * runs — throwing {@link AiBrokerError} carrying the exact captured error
 * envelope:
 *   - empty/missing `contents`            → `ai-error-empty-contents`
 *   - a role outside the captured list    → `ai-error-bad-role`
 *   - a model-turn functionCall part with no thoughtSignature
 *                                         → `ai-error-fncall-missing-thought-signature`
 *
 * Event emission is best-effort behind one small choke-point ({@link emit}):
 * a throw from the emit path (or any event consumer downstream) must never
 * poison the AI operation the caller just completed — handler errors are the
 * consumer's problem, never the broker's (the sandbox's emit fan-out already
 * isolates listener throws; this guard covers the emit path itself).
 */

import type { Sandbox } from 'pyric/sandbox';
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';

import { AiBrokerError, Synthesizer, badRole, emptyContents, missingThoughtSignature } from './synthesizer.js';
import { ScriptedEngine } from './scripted-engine.js';
import { OpenAiEngine } from './openai-engine.js';
import { GeminiEngine } from './gemini-engine.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  EngineConfig,
  GenerateContentRequest,
  RawEnvelope,
  WireChunk,
  WireResponse,
} from './types.js';

/**
 * Roles production accepts, from the captured rejection text
 * (`ai-error-bad-role`): "Please use a valid role: SYSTEM, SYSTEM_1, USER,
 * ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER." — compared
 * case-insensitively (the SDK sends lowercase `user`/`model`). `FUNCTION` is
 * additionally accepted: the captured message omits it, yet production
 * accepted the SDK's function-response turn (`ai-function-response-round`),
 * and the installed SDK threads those turns with role `function`.
 */
const ACCEPTED_ROLES = new Set([
  'SYSTEM',
  'SYSTEM_1',
  'USER',
  'ASSISTANT',
  'DEVELOPER',
  'CONTEXT',
  'USER_CONTEXT',
  'MODEL',
  'FUNCTION',
]);

export interface AiBrokerOptions {
  /** Engine config, or a fully custom engine. Default: zero-config scripted. */
  engine?: EngineConfig | AnswerEngine;
  /** When present, ops land on the sandbox's unified event stream. */
  sandbox?: Sandbox;
}

function isAnswerEngine(value: EngineConfig | AnswerEngine): value is AnswerEngine {
  return typeof (value as AnswerEngine).generateContent === 'function';
}

/** What Studio's stream (and the construction log line) name the engine. */
type EngineKind = 'scripted' | 'openai' | 'gemini' | 'custom';

export class AiBroker {
  readonly engine: AnswerEngine;
  private readonly sandbox: Sandbox | undefined;
  private readonly engineKind: EngineKind;
  private readonly engineModel: string | undefined;
  private readonly engineBaseUrl: string | undefined;

  constructor(options: AiBrokerOptions = {}) {
    this.sandbox = options.sandbox;
    const engine = options.engine ?? { kind: 'scripted' as const };
    if (isAnswerEngine(engine)) {
      this.engine = engine;
      this.engineKind = 'custom';
    } else if (engine.kind === 'scripted') {
      this.engine = new ScriptedEngine(engine.script ?? [], new Synthesizer());
      this.engineKind = 'scripted';
    } else if (engine.kind === 'gemini') {
      this.engine = new GeminiEngine(engine);
      this.engineKind = 'gemini';
      this.engineBaseUrl = engine.baseUrl;
    } else {
      this.engine = new OpenAiEngine(engine);
      this.engineKind = 'openai';
      this.engineModel = engine.model;
      this.engineBaseUrl = engine.baseUrl;
    }
    console.info(this.describeEngine());
  }

  /** One-line construction-time summary of what this broker resolved to. */
  private describeEngine(): string {
    const isOpenAiEngine = this.engineKind === 'openai';
    if (isOpenAiEngine) {
      return `[pyric/ai] engine resolved: openai (model=${this.engineModel ?? 'passthrough'}, upstream=${this.engineBaseUrl})`;
    }
    const isGeminiEngine = this.engineKind === 'gemini';
    if (isGeminiEngine) {
      return `[pyric/ai] engine resolved: gemini (upstream=${this.engineBaseUrl ?? 'https://generativelanguage.googleapis.com'})`;
    }
    const isCustomEngine = this.engineKind === 'custom';
    if (isCustomEngine) {
      return '[pyric/ai] engine resolved: custom AnswerEngine';
    }
    return '[pyric/ai] engine resolved: scripted (zero-config unless a script is queued)';
  }

  /** Additive detail fields every emitted event carries so Studio can show the engine. */
  private engineDetail(): Record<string, unknown> {
    const detail: Record<string, unknown> = {
      engine: this.engineKind,
    };
    const isOpenAiEngine = this.engineKind === 'openai';
    if (isOpenAiEngine) {
      detail.model = this.engineModel;
      detail.baseUrl = this.engineBaseUrl;
    }
    const isGeminiEngine = this.engineKind === 'gemini';
    if (isGeminiEngine) {
      detail.baseUrl = this.engineBaseUrl ?? 'https://generativelanguage.googleapis.com';
    }
    return detail;
  }

  private emitRejectionIfBrokerError(model: string, err: unknown): void {
    const code = err instanceof AiBrokerError ? err.envelope.error.code : 500;
    const status = err instanceof AiBrokerError ? err.envelope.error.status : 'INTERNAL';
    const message = err instanceof AiBrokerError
      ? err.envelope.error.message
      : err instanceof Error ? err.message : String(err);
    this.emit('request_rejected', model, { code, status, message });
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    this.validate(req, model);
    try {
      const response = await this.engine.generateContent(req, model);
      this.emit('generate_content', model, {
        contentCount: req.contents.length,
        finishReason: response.candidates?.[0]?.finishReason,
        totalTokenCount: response.usageMetadata?.totalTokenCount,
        responseId: response.responseId,
      });
      return response;
    } catch (err) {
      this.emitRejectionIfBrokerError(model, err);
      throw err;
    }
  }

  /**
   * Chunk objects with the captured framing SEMANTICS (finishReason last
   * chunk only, usageMetadata every chunk). Validation runs EAGERLY — a bad
   * request throws here, before iteration, the way production answers with
   * an HTTP error instead of a stream.
   */
  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk> {
    this.validate(req, model);
    const inner = this.engine.streamGenerateContent(req, model);
    const emit = (chunkCount: number) =>
      this.emit('stream_generate_content', model, {
        contentCount: req.contents.length,
        chunkCount,
      });
    const emitRejection = (err: unknown) => this.emitRejectionIfBrokerError(model, err);
    return (async function* wrapped(): AsyncGenerator<WireChunk> {
      let chunkCount = 0;
      try {
        for await (const chunk of inner) {
          chunkCount++;
          yield chunk;
        }
        emit(chunkCount);
      } catch (err) {
        emitRejection(err);
        throw err;
      }
    })();
  }

  async countTokens(req: CountTokensRequest, model: string): Promise<CountTokensResponse> {
    this.validateContents(req, model);
    try {
      const response = await this.engine.countTokens(req, model);
      this.emit('count_tokens', model, { totalTokens: response.totalTokens });
      return response;
    } catch (err) {
      this.emitRejectionIfBrokerError(model, err);
      throw err;
    }
  }

  // ── Production-shaped validation ──────────────────────────────────────────

  private validate(req: GenerateContentRequest, model: string): void {
    this.validateContents(req, model);
    // Model turns threading a functionCall back in MUST carry the
    // thoughtSignature production minted (`ai-error-fncall-missing-thought-signature`).
    for (let i = 0; i < req.contents.length; i++) {
      const content = req.contents[i]!;
      if ((content.role ?? '').toUpperCase() !== 'MODEL') continue;
      for (const part of content.parts ?? []) {
        if (part.functionCall && part.thoughtSignature === undefined) {
          // `position` is the 1-based index of the offending content turn.
          this.reject(model, missingThoughtSignature(part.functionCall.name, i + 1));
        }
      }
    }
  }

  private validateContents(req: { contents: unknown }, model: string): void {
    const contents = req.contents;
    if (!Array.isArray(contents) || contents.length === 0) {
      this.reject(model, emptyContents());
    }
    for (const content of contents as GenerateContentRequest['contents']) {
      const role = content.role ?? '';
      if (!ACCEPTED_ROLES.has(role.toUpperCase())) {
        this.reject(model, badRole(role));
      }
    }
  }

  /** Emit the rejection onto the event stream, then throw the wire envelope. */
  private reject(model: string, envelope: AiBrokerError['envelope']): never {
    this.emit('request_rejected', model, {
      code: envelope.error.code,
      status: envelope.error.status,
      message: envelope.error.message,
    });
    throw new AiBrokerError(envelope);
  }

  // ── Event emission (Studio stream consumer seam) ──────────────────────────

  /**
   * Land a broker operation on the sandbox's unified event stream.
   * Best-effort, storage-precedent: a throw from the emit path must never
   * fail the AI operation the caller just completed.
   */
  private emit(op: string, model: string, detail: Record<string, unknown>): void {
    if (this.sandbox === undefined) return;
    try {
      emitSandboxEvent(
        this.sandbox,
        makeServiceMutationEvent({
          service: 'ai',
          op,
          path: model,
          auth: null,
          detail: { ...detail, ...this.engineDetail() },
        }),
        { service: 'ai' },
      );
    } catch {
      // Observational — never let event emission break an AI op.
    }
  }
}

/**
 * Fixture helper: extract `behavior.raw` from a parsed oracle observation
 * JSON so a capture pastes straight into a script entry
 * (`{ respond: loadObservationEnvelope(obs) }`). Captures are the corpus.
 */
export function loadObservationEnvelope(obsJson: unknown): RawEnvelope {
  const raw = (obsJson as { behavior?: { raw?: unknown } })?.behavior?.raw;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as RawEnvelope).candidates)
  ) {
    throw new Error(
      'loadObservationEnvelope: observation has no behavior.raw response envelope (expected a capture with candidates)',
    );
  }
  return structuredClone(raw) as RawEnvelope;
}
