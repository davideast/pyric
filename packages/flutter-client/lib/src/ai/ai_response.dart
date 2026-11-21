import 'ai_config.dart';
import 'ai_content.dart';

/// Reason a candidate stopped generating tokens.
enum FinishReason {
  unknown('FINISH_REASON_UNSPECIFIED'),
  stop('STOP'),
  maxTokens('MAX_TOKENS'),
  safety('SAFETY'),
  recitation('RECITATION'),
  language('LANGUAGE'),
  blocklist('BLOCKLIST'),
  prohibitedContent('PROHIBITED_CONTENT'),
  spii('SPII'),
  malformedFunctionCall('MALFORMED_FUNCTION_CALL'),
  imageSafety('IMAGE_SAFETY'),
  imageProhibitedContent('IMAGE_PROHIBITED_CONTENT'),
  imageOther('IMAGE_OTHER'),
  noImage('NO_IMAGE'),
  imageRecitation('IMAGE_RECITATION'),
  unexpectedToolCall('UNEXPECTED_TOOL_CALL'),
  tooManyToolCalls('TOO_MANY_TOOL_CALLS'),
  missingThoughtSignature('MISSING_THOUGHT_SIGNATURE'),
  malformedResponse('MALFORMED_RESPONSE'),
  other('OTHER');

  final String wireValue;
  const FinishReason(this.wireValue);

  /// Whether this finish reason means candidate output was withheld by a filter or fault.
  bool get isBlocked {
    switch (this) {
      case FinishReason.safety:
      case FinishReason.recitation:
      case FinishReason.blocklist:
      case FinishReason.prohibitedContent:
      case FinishReason.spii:
      case FinishReason.malformedFunctionCall:
      case FinishReason.imageSafety:
      case FinishReason.imageProhibitedContent:
      case FinishReason.imageOther:
      case FinishReason.noImage:
      case FinishReason.imageRecitation:
      case FinishReason.language:
      case FinishReason.unexpectedToolCall:
      case FinishReason.tooManyToolCalls:
      case FinishReason.missingThoughtSignature:
      case FinishReason.malformedResponse:
        return true;
      case FinishReason.unknown:
      case FinishReason.stop:
      case FinishReason.maxTokens:
      case FinishReason.other:
        return false;
    }
  }

  static FinishReason? fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return null;
    }
    for (final value in FinishReason.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return FinishReason.unknown;
  }
}

/// Reason a prompt was refused before any candidate was generated.
enum BlockReason {
  unknown('BLOCKED_REASON_UNSPECIFIED'),
  safety('SAFETY'),
  other('OTHER'),
  blocklist('BLOCKLIST'),
  prohibitedContent('PROHIBITED_CONTENT');

  final String wireValue;
  const BlockReason(this.wireValue);

  static BlockReason? fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return null;
    }
    for (final value in BlockReason.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return BlockReason.unknown;
  }
}

/// Estimated probability that content matches a [HarmCategory].
enum HarmProbability {
  unknown('HARM_PROBABILITY_UNSPECIFIED'),
  negligible('NEGLIGIBLE'),
  low('LOW'),
  medium('MEDIUM'),
  high('HIGH');

  final String wireValue;
  const HarmProbability(this.wireValue);

  static HarmProbability fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return HarmProbability.unknown;
    }
    for (final value in HarmProbability.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return HarmProbability.unknown;
  }
}

/// Estimated harm severity level reported in a [SafetyRating].
enum HarmSeverity {
  unknown('HARM_SEVERITY_UNSPECIFIED'),
  negligible('HARM_SEVERITY_NEGLIGIBLE'),
  low('HARM_SEVERITY_LOW'),
  medium('HARM_SEVERITY_MEDIUM'),
  high('HARM_SEVERITY_HIGH'),
  unsupported('HARM_SEVERITY_UNSUPPORTED');

  final String wireValue;
  const HarmSeverity(this.wireValue);

  static HarmSeverity? fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return null;
    }
    for (final value in HarmSeverity.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return HarmSeverity.unknown;
  }
}

/// Safety evaluation result for a single [HarmCategory].
final class SafetyRating {
  final HarmCategory category;
  final HarmProbability probability;
  final double? probabilityScore;
  final HarmSeverity? severity;
  final double? severityScore;
  final bool? isBlocked;

  const SafetyRating(
    this.category,
    this.probability, {
    this.probabilityScore,
    this.severity,
    this.severityScore,
    this.isBlocked,
  });
}

/// Source attribution entry inside [CitationMetadata].
final class Citation {
  final int? startIndex;
  final int? endIndex;
  final Uri? uri;
  final String? license;

  const Citation({
    this.startIndex,
    this.endIndex,
    this.uri,
    this.license,
  });
}

/// Source citations attached to a generated [Candidate].
final class CitationMetadata {
  final List<Citation> citations;

  CitationMetadata(Iterable<Citation> citations)
      : citations = List<Citation>.unmodifiable(citations);
}

/// A single response candidate returned by the Gemini model.
final class Candidate {
  final Content content;
  final List<SafetyRating>? safetyRatings;
  final CitationMetadata? citationMetadata;
  final FinishReason? finishReason;
  final String? finishMessage;
  final int? index;

  Candidate(
    this.content,
    List<SafetyRating>? safetyRatings,
    this.citationMetadata,
    this.finishReason,
    this.finishMessage, {
    this.index,
  }) : safetyRatings = safetyRatings == null
            ? null
            : List<SafetyRating>.unmodifiable(safetyRatings);

  /// Concatenated non-thought [TextPart] text for this candidate, or `null`
  /// when blocked or when no non-thought text parts exist.
  String? get text {
    if (finishReason?.isBlocked ?? false) {
      return null;
    }
    final textParts = content.parts.whereType<TextPart>().toList(growable: false);
    if (textParts.isEmpty) {
      return null;
    }
    final buffer = StringBuffer();
    for (final part in textParts) {
      buffer.write(part.text);
    }
    return buffer.toString();
  }
}

/// Prompt-level safety feedback returned when a prompt is evaluated or blocked.
final class PromptFeedback {
  final BlockReason? blockReason;
  final String? blockReasonMessage;
  final List<SafetyRating> safetyRatings;

  PromptFeedback(
    this.blockReason,
    this.blockReasonMessage,
    Iterable<SafetyRating> safetyRatings,
  ) : safetyRatings = List<SafetyRating>.unmodifiable(safetyRatings);
}

/// Content modality reported in token usage breakdowns.
enum Modality {
  unspecified('MODALITY_UNSPECIFIED'),
  text('TEXT'),
  image('IMAGE'),
  video('VIDEO'),
  audio('AUDIO'),
  document('DOCUMENT');

  final String wireValue;
  const Modality(this.wireValue);

  static Modality fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return Modality.unspecified;
    }
    for (final value in Modality.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return Modality.unspecified;
  }
}

/// Token count attributed to a single [Modality].
final class ModalityTokenCount {
  final Modality modality;
  final int tokenCount;

  const ModalityTokenCount(this.modality, this.tokenCount);
}

/// Token usage accounting returned alongside a [GenerateContentResponse].
final class UsageMetadata {
  final int? promptTokenCount;
  final int? candidatesTokenCount;
  final int? totalTokenCount;
  final int? thoughtsTokenCount;
  final int? cachedContentTokenCount;
  final int? toolUsePromptTokenCount;
  final List<ModalityTokenCount>? promptTokensDetails;
  final List<ModalityTokenCount>? candidatesTokensDetails;

  UsageMetadata({
    this.promptTokenCount,
    this.candidatesTokenCount,
    this.totalTokenCount,
    this.thoughtsTokenCount,
    this.cachedContentTokenCount,
    this.toolUsePromptTokenCount,
    List<ModalityTokenCount>? promptTokensDetails,
    List<ModalityTokenCount>? candidatesTokensDetails,
  })  : promptTokensDetails = promptTokensDetails == null
            ? null
            : List<ModalityTokenCount>.unmodifiable(promptTokensDetails),
        candidatesTokensDetails = candidatesTokensDetails == null
            ? null
            : List<ModalityTokenCount>.unmodifiable(candidatesTokensDetails);
}

/// Response returned by `GenerativeModel.generateContent` and stream chunks.
final class GenerateContentResponse {
  final List<Candidate> candidates;
  final PromptFeedback? promptFeedback;
  final UsageMetadata? usageMetadata;
  final String? modelVersion;
  final String? responseId;

  GenerateContentResponse(
    Iterable<Candidate> candidates,
    this.promptFeedback, {
    this.usageMetadata,
    this.modelVersion,
    this.responseId,
  }) : candidates = List<Candidate>.unmodifiable(candidates);

  /// Concatenated non-thought [TextPart] strings from the first candidate, or
  /// `null` when no candidates exist, the candidate was blocked, or no text
  /// parts are present.
  String? get text {
    if (candidates.isEmpty) {
      return null;
    }
    return candidates.first.text;
  }

  /// Concatenated [ThoughtPart] reasoning summary from the first candidate, or
  /// `null` when no thought parts exist or the candidate was blocked.
  String? get thoughtSummary {
    if (candidates.isEmpty) {
      return null;
    }
    final first = candidates.first;
    if (first.finishReason?.isBlocked ?? false) {
      return null;
    }
    final thoughts =
        first.content.parts.whereType<ThoughtPart>().toList(growable: false);
    if (thoughts.isEmpty) {
      return null;
    }
    final buffer = StringBuffer();
    for (final thought in thoughts) {
      buffer.write(thought.text);
    }
    return buffer.toString();
  }

  /// All [FunctionCall] parts emitted in the first candidate, in part order.
  Iterable<FunctionCall> get functionCalls {
    if (candidates.isEmpty) {
      return const <FunctionCall>[];
    }
    final first = candidates.first;
    if (first.finishReason?.isBlocked ?? false) {
      return const <FunctionCall>[];
    }
    return List<FunctionCall>.unmodifiable(
      first.content.parts.whereType<FunctionCall>(),
    );
  }

  /// All [InlineDataPart] payloads emitted in the first candidate, in part order.
  Iterable<InlineDataPart> get inlineDataParts {
    if (candidates.isEmpty) {
      return const <InlineDataPart>[];
    }
    final first = candidates.first;
    if (first.finishReason?.isBlocked ?? false) {
      return const <InlineDataPart>[];
    }
    return List<InlineDataPart>.unmodifiable(
      first.content.parts.whereType<InlineDataPart>(),
    );
  }
}

/// Deterministic token accounting returned by `GenerativeModel.countTokens`.
final class CountTokensResponse {
  final int totalTokens;
  final int? totalBillableCharacters;
  final List<ModalityTokenCount>? promptTokensDetails;

  CountTokensResponse(
    this.totalTokens, {
    this.totalBillableCharacters,
    List<ModalityTokenCount>? promptTokensDetails,
  }) : promptTokensDetails = promptTokensDetails == null
            ? null
            : List<ModalityTokenCount>.unmodifiable(promptTokensDetails);
}
