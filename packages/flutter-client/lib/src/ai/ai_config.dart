import 'ai_exception.dart';
import 'ai_schema.dart';

export 'ai_schema.dart';
export 'ai_tool.dart';

/// Harm categories evaluated by Gemini safety filters.
enum HarmCategory {
  unknown('HARM_CATEGORY_UNSPECIFIED'),
  harassment('HARM_CATEGORY_HARASSMENT'),
  hateSpeech('HARM_CATEGORY_HATE_SPEECH'),
  sexuallyExplicit('HARM_CATEGORY_SEXUALLY_EXPLICIT'),
  dangerousContent('HARM_CATEGORY_DANGEROUS_CONTENT'),
  civicIntegrity('HARM_CATEGORY_CIVIC_INTEGRITY');

  final String wireValue;
  const HarmCategory(this.wireValue);

  static HarmCategory fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return HarmCategory.unknown;
    }
    for (final value in HarmCategory.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return HarmCategory.unknown;
  }
}

/// Threshold above which prompts or candidates are blocked for a [HarmCategory].
enum HarmBlockThreshold {
  unspecified('HARM_BLOCK_THRESHOLD_UNSPECIFIED'),
  low('BLOCK_LOW_AND_ABOVE'),
  medium('BLOCK_MEDIUM_AND_ABOVE'),
  high('BLOCK_ONLY_HIGH'),
  none('BLOCK_NONE'),
  off('OFF');

  final String wireValue;
  const HarmBlockThreshold(this.wireValue);

  static HarmBlockThreshold fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return HarmBlockThreshold.unspecified;
    }
    for (final value in HarmBlockThreshold.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return HarmBlockThreshold.unspecified;
  }
}

/// Scoring method used to compare harm scores against a [HarmBlockThreshold].
enum HarmBlockMethod {
  unspecified('HARM_BLOCK_METHOD_UNSPECIFIED'),
  severity('SEVERITY'),
  probability('PROBABILITY');

  final String wireValue;
  const HarmBlockMethod(this.wireValue);

  static HarmBlockMethod fromWire(String? raw) {
    if (raw == null || raw.isEmpty) {
      return HarmBlockMethod.unspecified;
    }
    for (final value in HarmBlockMethod.values) {
      if (value.wireValue == raw) {
        return value;
      }
    }
    return HarmBlockMethod.unspecified;
  }
}

/// Per-category content safety filter configuration.
final class SafetySetting {
  final HarmCategory category;
  final HarmBlockThreshold threshold;
  final HarmBlockMethod? method;

  const SafetySetting(this.category, this.threshold, [this.method]);

  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'category': category.wireValue,
      'threshold': threshold.wireValue,
      if (method != null && method != HarmBlockMethod.unspecified)
        'method': method!.wireValue,
    };
  }
}

/// Preset controlling reasoning depth on thinking-capable Gemini models.
enum ThinkingLevel {
  minimal('MINIMAL'),
  low('LOW'),
  medium('MEDIUM'),
  high('HIGH');

  final String wireValue;
  const ThinkingLevel(this.wireValue);
}

/// Configuration for model reasoning / thinking tokens (`thinkingConfig`).
final class ThinkingConfig {
  final int? thinkingBudget;
  final bool? includeThoughts;
  final ThinkingLevel? thinkingLevel;

  const ThinkingConfig({
    this.thinkingBudget,
    this.includeThoughts,
    this.thinkingLevel,
  });

  /// Constructs a [ThinkingConfig] targeting a numeric [thinkingBudget].
  factory ThinkingConfig.withThinkingBudget(
    int thinkingBudget, {
    bool? includeThoughts,
  }) =>
      ThinkingConfig(
        thinkingBudget: thinkingBudget,
        includeThoughts: includeThoughts,
      );

  /// Constructs a [ThinkingConfig] targeting a preset [thinkingLevel].
  factory ThinkingConfig.withThinkingLevel(
    ThinkingLevel thinkingLevel, {
    bool? includeThoughts,
  }) =>
      ThinkingConfig(
        thinkingLevel: thinkingLevel,
        includeThoughts: includeThoughts,
      );

  /// Validates mutual exclusion between [thinkingBudget] and [thinkingLevel].
  void validate() {
    if (thinkingBudget != null && thinkingLevel != null) {
      throw const FirebaseAIException(
        'Cannot set both thinkingBudget and thinkingLevel in a config.',
        code: 'unsupported',
      );
    }
  }

  Map<String, dynamic> toJson() {
    validate();
    return <String, dynamic>{
      if (thinkingBudget != null) 'thinkingBudget': thinkingBudget,
      if (includeThoughts != null) 'includeThoughts': includeThoughts,
      if (thinkingLevel != null) 'thinkingLevel': thinkingLevel!.wireValue,
    };
  }
}

/// Requested output modalities in [GenerationConfig.responseModalities].
enum ResponseModality {
  text('TEXT'),
  image('IMAGE'),
  audio('AUDIO');

  final String wireValue;
  const ResponseModality(this.wireValue);
}

/// Controls sampling, output formatting, structured schema, and thinking behavior.
final class GenerationConfig {
  final int? candidateCount;
  final List<String>? stopSequences;
  final int? maxOutputTokens;
  final double? temperature;
  final double? topP;
  final int? topK;
  final double? presencePenalty;
  final double? frequencyPenalty;
  final String? responseMimeType;
  final Schema? responseSchema;
  final List<ResponseModality>? responseModalities;
  final ThinkingConfig? thinkingConfig;

  GenerationConfig({
    this.candidateCount,
    List<String>? stopSequences,
    this.maxOutputTokens,
    this.temperature,
    this.topP,
    this.topK,
    this.presencePenalty,
    this.frequencyPenalty,
    this.responseMimeType,
    this.responseSchema,
    List<ResponseModality>? responseModalities,
    this.thinkingConfig,
  })  : stopSequences = stopSequences == null
            ? null
            : List<String>.unmodifiable(stopSequences),
        responseModalities = responseModalities == null
            ? null
            : List<ResponseModality>.unmodifiable(responseModalities);

  /// Validates nested configuration constraints before sending a request.
  void validate() {
    thinkingConfig?.validate();
  }

  Map<String, dynamic> toJson() {
    validate();
    return <String, dynamic>{
      if (candidateCount != null) 'candidateCount': candidateCount,
      if (stopSequences != null) 'stopSequences': stopSequences,
      if (maxOutputTokens != null) 'maxOutputTokens': maxOutputTokens,
      if (temperature != null) 'temperature': temperature,
      if (topP != null) 'topP': topP,
      if (topK != null) 'topK': topK,
      if (presencePenalty != null) 'presencePenalty': presencePenalty,
      if (frequencyPenalty != null) 'frequencyPenalty': frequencyPenalty,
      if (responseMimeType != null) 'responseMimeType': responseMimeType,
      if (responseSchema != null) 'responseSchema': responseSchema!.toJson(),
      if (responseModalities != null)
        'responseModalities': responseModalities!
            .map((modality) => modality.wireValue)
            .toList(growable: false),
      if (thinkingConfig != null) 'thinkingConfig': thinkingConfig!.toJson(),
    };
  }
}
