import 'dart:async';

import '../transport/bridge_client.dart';
import 'ai_config.dart';
import 'ai_content.dart';
import 'ai_exception.dart';
import 'ai_response.dart';
import 'ai_stream.dart';
import 'ai_wire_codec.dart';
import 'chat_session.dart';

/// Resolves the optional `appCheck: { token }` wire claim for an AI operation.
typedef AiAppCheckWireResolver = Future<Map<String, dynamic>?> Function();

/// Generative AI model bound to a Pyric WebSocket bridge and backend target.
final class GenerativeModel {
  /// Normalized model resource path (`models/<id>` on Google AI,
  /// `publishers/google/models/<id>` on Vertex AI).
  final String model;

  /// Model-level generation configuration defaults.
  final GenerationConfig? generationConfig;

  /// Model-level safety filter settings.
  final List<SafetySetting>? safetySettings;

  /// Model-level tool declarations.
  final List<Tool>? tools;

  /// Model-level tool calling policy.
  final ToolConfig? toolConfig;

  /// Model-level system instruction turn.
  final Content? systemInstruction;

  final PyricBridgeClient _bridgeClient;
  final AiAppCheckWireResolver _appCheckResolver;
  final Map<String, dynamic>? _engineWire;

  GenerativeModel({
    required String modelName,
    required bool isVertexAI,
    required PyricBridgeClient bridgeClient,
    required AiAppCheckWireResolver appCheckResolver,
    Map<String, dynamic>? engineWire,
    this.generationConfig,
    List<SafetySetting>? safetySettings,
    List<Tool>? tools,
    this.toolConfig,
    this.systemInstruction,
  })  : model = normalizeAiModelResource(modelName, isVertexAI: isVertexAI),
        safetySettings = safetySettings == null
            ? null
            : List<SafetySetting>.unmodifiable(safetySettings),
        tools = tools == null ? null : List<Tool>.unmodifiable(tools),
        _bridgeClient = bridgeClient,
        _appCheckResolver = appCheckResolver,
        _engineWire = engineWire == null
            ? null
            : Map<String, dynamic>.unmodifiable(engineWire) {
    generationConfig?.validate();
  }

  /// Underlying Pyric WebSocket bridge client used by unary and streaming ops.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Optional first-op engine configuration wire payload, if configured.
  Map<String, dynamic>? get engineWire => _engineWire;

  /// Resolves the `appCheck: { token }` wire payload for outbound AI frames.
  Future<Map<String, dynamic>?> resolveAppCheckWire() => _appCheckResolver();

  /// Builds the merged Gemini wire request JSON for [prompt] and per-call overrides.
  Map<String, dynamic> buildGenerateContentWireRequest(
    Iterable<Content> prompt, {
    List<SafetySetting>? safetySettings,
    GenerationConfig? generationConfig,
    List<Tool>? tools,
    ToolConfig? toolConfig,
  }) {
    return encodeGenerateContentRequest(
      prompt: prompt,
      systemInstruction: systemInstruction,
      generationConfig: generationConfig ?? this.generationConfig,
      safetySettings: safetySettings ?? this.safetySettings,
      tools: tools ?? this.tools,
      toolConfig: toolConfig ?? this.toolConfig,
    );
  }

  /// Generates a single model response for [prompt] via `ai.generateContent`.
  Future<GenerateContentResponse> generateContent(
    Iterable<Content> prompt, {
    List<SafetySetting>? safetySettings,
    GenerationConfig? generationConfig,
    List<Tool>? tools,
    ToolConfig? toolConfig,
  }) async {
    try {
      final requestJson = buildGenerateContentWireRequest(
        prompt,
        safetySettings: safetySettings,
        generationConfig: generationConfig,
        tools: tools,
        toolConfig: toolConfig,
      );
      await _ensureBridgeConnected();
      final appCheckClaim = await resolveAppCheckWire();
      final params = <String, dynamic>{
        'model': model,
        'request': requestJson,
        if (_engineWire != null) 'engine': _engineWire,
        if (appCheckClaim != null) 'appCheck': appCheckClaim,
      };
      final raw = await _bridgeClient.op('ai.generateContent', params);
      return decodeGenerateContentResponse(raw);
    } catch (error) {
      throw mapBridgeErrorToFirebaseAIException(error);
    }
  }

  /// Streams partial [GenerateContentResponse] chunks for [prompt] via
  /// `ai.streamGenerateContent` (`worker-sub` / `worker-snap` / `worker-unsub`).
  Stream<GenerateContentResponse> generateContentStream(
    Iterable<Content> prompt, {
    List<SafetySetting>? safetySettings,
    GenerationConfig? generationConfig,
    List<Tool>? tools,
    ToolConfig? toolConfig,
  }) {
    return streamAiGenerateContent<GenerateContentResponse>(
      bridgeClient: _bridgeClient,
      buildSubPayload: () async {
        final requestJson = buildGenerateContentWireRequest(
          prompt,
          safetySettings: safetySettings,
          generationConfig: generationConfig,
          tools: tools,
          toolConfig: toolConfig,
        );
        await _ensureBridgeConnected();
        final appCheckClaim = await resolveAppCheckWire();
        return <String, dynamic>{
          'target': const <String, dynamic>{
            'service': 'ai',
            'op': 'streamGenerateContent',
          },
          'model': model,
          'request': requestJson,
          if (_engineWire != null) 'engine': _engineWire,
          if (appCheckClaim != null) 'appCheck': appCheckClaim,
        };
      },
      decodeChunk: decodeGenerateContentResponse,
      mapError: mapBridgeErrorToFirebaseAIException,
    );
  }

  /// Starts a stateful multi-turn [ChatSession] inheriting this model's
  /// defaults unless overridden.
  ChatSession startChat({
    List<Content>? history,
    List<SafetySetting>? safetySettings,
    GenerationConfig? generationConfig,
    List<Tool>? tools,
    ToolConfig? toolConfig,
  }) {
    return ChatSession(
      model: this,
      history: history,
      safetySettings: safetySettings ?? this.safetySettings,
      generationConfig: generationConfig ?? this.generationConfig,
      tools: tools ?? this.tools,
      toolConfig: toolConfig ?? this.toolConfig,
    );
  }

  /// Counts prompt tokens deterministically via `ai.countTokens`.
  Future<CountTokensResponse> countTokens(
    Iterable<Content> prompt, {
    List<SafetySetting>? safetySettings,
    GenerationConfig? generationConfig,
    List<Tool>? tools,
    ToolConfig? toolConfig,
  }) async {
    try {
      final requestJson = encodeCountTokensRequest(
        prompt: prompt,
        systemInstruction: systemInstruction,
        generationConfig: generationConfig ?? this.generationConfig,
        tools: tools ?? this.tools,
      );
      await _ensureBridgeConnected();
      final appCheckClaim = await resolveAppCheckWire();
      final params = <String, dynamic>{
        'model': model,
        'request': requestJson,
        if (_engineWire != null) 'engine': _engineWire,
        if (appCheckClaim != null) 'appCheck': appCheckClaim,
      };
      final raw = await _bridgeClient.op('ai.countTokens', params);
      return decodeCountTokensResponse(raw);
    } catch (error) {
      throw mapBridgeErrorToFirebaseAIException(error);
    }
  }

  Future<void> _ensureBridgeConnected() async {
    if (!_bridgeClient.isConnected) {
      await _bridgeClient.connect();
    }
  }
}
