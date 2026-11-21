import 'dart:convert';
import 'dart:typed_data';

import 'ai_config.dart';
import 'ai_content.dart';
import 'ai_exception.dart';
import 'ai_response.dart';

/// Normalizes a Gemini model identifier for Google AI (`models/<name>`) or
/// Vertex AI (`publishers/google/models/<name>`).
String normalizeAiModelResource(
  String modelName, {
  required bool isVertexAI,
}) {
  final trimmed = modelName.trim();
  if (trimmed.isEmpty) {
    throw const FirebaseAIException(
      'Must provide a non-empty model name.',
      code: 'no-model',
    );
  }
  if (isVertexAI) {
    if (trimmed.contains('/')) {
      if (trimmed.startsWith('models/')) {
        return 'publishers/google/$trimmed';
      }
      return trimmed;
    }
    return 'publishers/google/models/$trimmed';
  }
  if (trimmed.startsWith('models/')) {
    return trimmed;
  }
  return 'models/$trimmed';
}

Map<String, dynamic> _encodeSystemInstruction(Content systemInstruction) {
  return <String, dynamic>{
    'role': systemInstruction.role ?? 'system',
    'parts': systemInstruction.parts
        .map((part) => part.toJson())
        .toList(growable: false),
  };
}

/// Encodes a `generateContent` / `streamGenerateContent` Gemini wire request.
Map<String, dynamic> encodeGenerateContentRequest({
  required Iterable<Content> prompt,
  Content? systemInstruction,
  GenerationConfig? generationConfig,
  List<SafetySetting>? safetySettings,
  List<Tool>? tools,
  ToolConfig? toolConfig,
}) {
  generationConfig?.validate();
  final contentsJson =
      prompt.map((content) => content.toJson()).toList(growable: false);
  final request = <String, dynamic>{
    'contents': contentsJson,
  };
  if (systemInstruction != null) {
    request['systemInstruction'] = _encodeSystemInstruction(systemInstruction);
  }
  if (generationConfig != null) {
    final configJson = generationConfig.toJson();
    if (configJson.isNotEmpty) {
      request['generationConfig'] = configJson;
    }
  }
  if (safetySettings != null && safetySettings.isNotEmpty) {
    request['safetySettings'] = safetySettings
        .map((setting) => setting.toJson())
        .toList(growable: false);
  }
  if (tools != null && tools.isNotEmpty) {
    request['tools'] =
        tools.map((tool) => tool.toJson()).toList(growable: false);
  }
  if (toolConfig != null) {
    final toolConfigJson = toolConfig.toJson();
    if (toolConfigJson.isNotEmpty) {
      request['toolConfig'] = toolConfigJson;
    }
  }
  return request;
}

/// Encodes a `countTokens` Gemini wire request.
Map<String, dynamic> encodeCountTokensRequest({
  required Iterable<Content> prompt,
  Content? systemInstruction,
  GenerationConfig? generationConfig,
  List<Tool>? tools,
}) {
  generationConfig?.validate();
  final contentsJson =
      prompt.map((content) => content.toJson()).toList(growable: false);
  final request = <String, dynamic>{
    'contents': contentsJson,
  };
  if (systemInstruction != null) {
    request['systemInstruction'] = _encodeSystemInstruction(systemInstruction);
  }
  if (generationConfig != null) {
    final configJson = generationConfig.toJson();
    if (configJson.isNotEmpty) {
      request['generationConfig'] = configJson;
    }
  }
  if (tools != null && tools.isNotEmpty) {
    request['tools'] =
        tools.map((tool) => tool.toJson()).toList(growable: false);
  }
  return request;
}

Uint8List _decodeBase64Bytes(String encoded) {
  try {
    return base64Decode(base64.normalize(encoded.trim()));
  } on FormatException catch (error) {
    throw SerializationException(
      'Invalid base64 payload in inlineData.data: ${error.message}',
    );
  }
}

/// Decodes a single wire [Part] map returned by the Gemini broker.
Part decodeWirePart(Map<String, dynamic> raw) {
  final thoughtSignature = raw['thoughtSignature'] as String?;

  if (raw['thought'] == true && raw['text'] is String) {
    return ThoughtPart(
      raw['text'] as String,
      thoughtSignature: thoughtSignature,
    );
  }
  if (raw['text'] is String) {
    return TextPart(
      raw['text'] as String,
      thoughtSignature: thoughtSignature,
    );
  }
  if (raw['inlineData'] is Map) {
    final inlineMap = Map<String, dynamic>.from(raw['inlineData'] as Map);
    final mimeType = inlineMap['mimeType'] as String? ?? 'application/octet-stream';
    final dataStr = inlineMap['data'] as String? ?? '';
    final willContinue = inlineMap['willContinue'] as bool?;
    return InlineDataPart(
      mimeType,
      _decodeBase64Bytes(dataStr),
      willContinue: willContinue,
      thoughtSignature: thoughtSignature,
    );
  }
  if (raw['fileData'] is Map) {
    final fileMap = Map<String, dynamic>.from(raw['fileData'] as Map);
    final mimeType = fileMap['mimeType'] as String? ?? 'application/octet-stream';
    final fileUri = fileMap['fileUri'] as String? ?? '';
    return FileData(
      mimeType,
      fileUri,
      thoughtSignature: thoughtSignature,
    );
  }
  if (raw['functionCall'] is Map) {
    final fnMap = Map<String, dynamic>.from(raw['functionCall'] as Map);
    final name = fnMap['name'] as String? ?? '';
    final rawArgs = fnMap['args'];
    final args = rawArgs is Map
        ? Map<String, Object?>.from(rawArgs)
        : const <String, Object?>{};
    final id = fnMap['id'] as String?;
    return FunctionCall(
      name,
      args,
      id: id,
      thoughtSignature: thoughtSignature,
    );
  }
  if (raw['functionResponse'] is Map) {
    final respMap = Map<String, dynamic>.from(raw['functionResponse'] as Map);
    final name = respMap['name'] as String? ?? '';
    final rawResponse = respMap['response'];
    final response = rawResponse is Map
        ? Map<String, Object?>.from(rawResponse)
        : const <String, Object?>{};
    final id = respMap['id'] as String?;
    return FunctionResponse(name, response, id: id);
  }
  return UnknownPart(raw);
}

/// Decodes a wire [Content] map returned inside a [Candidate].
Content decodeWireContent(Map<String, dynamic>? raw) {
  if (raw == null) {
    return Content.model(const <Part>[]);
  }
  final role = raw['role'] as String? ?? 'model';
  final rawParts = raw['parts'];
  final parts = <Part>[];
  if (rawParts is List) {
    for (final entry in rawParts) {
      if (entry is Map) {
        parts.add(decodeWirePart(Map<String, dynamic>.from(entry)));
      }
    }
  }
  return Content(role, parts);
}

List<SafetyRating> _decodeSafetyRatings(Object? rawList) {
  if (rawList is! List) {
    return const <SafetyRating>[];
  }
  final ratings = <SafetyRating>[];
  for (final item in rawList) {
    if (item is! Map) {
      continue;
    }
    final map = Map<String, dynamic>.from(item);
    ratings.add(
      SafetyRating(
        HarmCategory.fromWire(map['category'] as String?),
        HarmProbability.fromWire(map['probability'] as String?),
        probabilityScore: (map['probabilityScore'] as num?)?.toDouble(),
        severity: HarmSeverity.fromWire(map['severity'] as String?),
        severityScore: (map['severityScore'] as num?)?.toDouble(),
        isBlocked: map['blocked'] as bool?,
      ),
    );
  }
  return ratings;
}

CitationMetadata? _decodeCitationMetadata(Object? raw) {
  if (raw is! Map) {
    return null;
  }
  final map = Map<String, dynamic>.from(raw);
  final rawSources = map['citations'] ?? map['citationSources'];
  if (rawSources is! List) {
    return CitationMetadata(const <Citation>[]);
  }
  final citations = <Citation>[];
  for (final item in rawSources) {
    if (item is! Map) {
      continue;
    }
    final entry = Map<String, dynamic>.from(item);
    final uriStr = entry['uri'] as String?;
    citations.add(
      Citation(
        startIndex: (entry['startIndex'] as num?)?.toInt(),
        endIndex: (entry['endIndex'] as num?)?.toInt(),
        uri: (uriStr != null && uriStr.isNotEmpty) ? Uri.tryParse(uriStr) : null,
        license: entry['license'] as String?,
      ),
    );
  }
  return CitationMetadata(citations);
}

Candidate _decodeCandidate(Map<String, dynamic> raw, int fallbackIndex) {
  final rawContent = raw['content'] is Map
      ? Map<String, dynamic>.from(raw['content'] as Map)
      : null;
  final rawRatings = raw['safetyRatings'];
  return Candidate(
    decodeWireContent(rawContent),
    rawRatings is List ? _decodeSafetyRatings(rawRatings) : null,
    _decodeCitationMetadata(raw['citationMetadata']),
    FinishReason.fromWire(raw['finishReason'] as String?),
    raw['finishMessage'] as String?,
    index: (raw['index'] as num?)?.toInt() ?? fallbackIndex,
  );
}

PromptFeedback? _decodePromptFeedback(Object? raw) {
  if (raw is! Map) {
    return null;
  }
  final map = Map<String, dynamic>.from(raw);
  return PromptFeedback(
    BlockReason.fromWire(map['blockReason'] as String?),
    map['blockReasonMessage'] as String?,
    _decodeSafetyRatings(map['safetyRatings']),
  );
}

List<ModalityTokenCount>? _decodeModalityTokenCounts(Object? raw) {
  if (raw is! List) {
    return null;
  }
  final details = <ModalityTokenCount>[];
  for (final item in raw) {
    if (item is! Map) {
      continue;
    }
    final entry = Map<String, dynamic>.from(item);
    details.add(
      ModalityTokenCount(
        Modality.fromWire(entry['modality'] as String?),
        (entry['tokenCount'] as num?)?.toInt() ?? 0,
      ),
    );
  }
  return details;
}

UsageMetadata? _decodeUsageMetadata(Object? raw) {
  if (raw is! Map) {
    return null;
  }
  final map = Map<String, dynamic>.from(raw);
  return UsageMetadata(
    promptTokenCount: (map['promptTokenCount'] as num?)?.toInt(),
    candidatesTokenCount: (map['candidatesTokenCount'] as num?)?.toInt(),
    totalTokenCount: (map['totalTokenCount'] as num?)?.toInt(),
    thoughtsTokenCount: (map['thoughtsTokenCount'] as num?)?.toInt(),
    cachedContentTokenCount: (map['cachedContentTokenCount'] as num?)?.toInt(),
    toolUsePromptTokenCount: (map['toolUsePromptTokenCount'] as num?)?.toInt(),
    promptTokensDetails: _decodeModalityTokenCounts(map['promptTokensDetails']),
    candidatesTokensDetails:
        _decodeModalityTokenCounts(map['candidatesTokensDetails']),
  );
}

/// Decodes a unary or streamed [GenerateContentResponse] wire envelope.
GenerateContentResponse decodeGenerateContentResponse(Object? raw) {
  if (raw is! Map) {
    throw const SerializationException(
      'Expected JSON object for GenerateContentResponse from Pyric bridge.',
    );
  }
  final map = Map<String, dynamic>.from(raw);
  final candidates = <Candidate>[];
  final rawCandidates = map['candidates'];
  if (rawCandidates is List) {
    for (var i = 0; i < rawCandidates.length; i += 1) {
      final entry = rawCandidates[i];
      if (entry is Map) {
        candidates.add(
          _decodeCandidate(Map<String, dynamic>.from(entry), i),
        );
      }
    }
  }
  return GenerateContentResponse(
    candidates,
    _decodePromptFeedback(map['promptFeedback']),
    usageMetadata: _decodeUsageMetadata(map['usageMetadata']),
    modelVersion: map['modelVersion'] as String?,
    responseId: map['responseId'] as String?,
  );
}

/// Decodes a [CountTokensResponse] wire envelope returned by `ai.countTokens`.
CountTokensResponse decodeCountTokensResponse(Object? raw) {
  if (raw is! Map) {
    throw const SerializationException(
      'Expected JSON object for CountTokensResponse from Pyric bridge.',
    );
  }
  final map = Map<String, dynamic>.from(raw);
  final totalRaw = map['totalTokens'];
  if (totalRaw is! num) {
    throw const SerializationException(
      'CountTokensResponse from Pyric bridge lacked numeric totalTokens.',
    );
  }
  return CountTokensResponse(
    totalRaw.toInt(),
    totalBillableCharacters: (map['totalBillableCharacters'] as num?)?.toInt(),
    promptTokensDetails: _decodeModalityTokenCounts(map['promptTokensDetails']),
  );
}
