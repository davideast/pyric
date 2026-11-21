import 'ai_schema.dart';

/// Execution mode governing how Gemini predicts function calls for declared tools.
enum FunctionCallingMode {
  /// Default behavior: the model decides whether to invoke a function or answer in text.
  auto('AUTO'),

  /// Forces the model to predict at least one function call (optionally restricted to `allowedFunctionNames`).
  any('ANY'),

  /// Prohibits the model from emitting function calls.
  none('NONE');

  final String wireValue;

  const FunctionCallingMode(this.wireValue);

  /// Serializes this mode to its uppercase Gemini wire identifier (`AUTO`, `ANY`, `NONE`).
  String toJson() => wireValue;
}

/// OpenAPI 3.0 tool function declaration exposed to Gemini via [Tool.functionDeclarations].
class FunctionDeclaration {
  final String name;
  final String description;
  final Map<String, Schema> parameters;
  final List<String> optionalParameters;
  final Schema? _parametersSchema;

  /// Declares a callable function with [name], [description], and named [parameters].
  ///
  /// Keys listed in [optionalParameters] are omitted from the wire `required` array;
  /// every key in [optionalParameters] must exist in [parameters].
  FunctionDeclaration(
    this.name,
    this.description, {
    Map<String, Schema> parameters = const <String, Schema>{},
    List<String> optionalParameters = const <String>[],
  })  : parameters = Map<String, Schema>.unmodifiable(parameters),
        optionalParameters = List<String>.unmodifiable(optionalParameters),
        _parametersSchema = (parameters.isEmpty && optionalParameters.isEmpty)
            ? null
            : Schema.object(
                properties: parameters,
                optionalProperties: optionalParameters,
              ) {
    if (name.trim().isEmpty) {
      throw ArgumentError('FunctionDeclaration name must not be empty.');
    }
  }

  /// Serializes this declaration to Gemini `FunctionDeclaration` wire JSON.
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{
      'name': name,
      'description': description,
    };
    if (_parametersSchema != null) {
      json['parameters'] = _parametersSchema.toJson();
    }
    return json;
  }
}

/// Tool definition passed to `GenerativeModel` or `startChat`.
class Tool {
  final List<FunctionDeclaration>? functionDeclarations;
  final Map<String, dynamic>? _rawJsonOverride;

  /// Creates a [Tool] from a pre-serialized wire JSON map.
  Tool.fromJsonMap(Map<String, dynamic> json)
      : _rawJsonOverride = Map<String, dynamic>.unmodifiable(json),
        functionDeclarations = null;

  /// Creates a [Tool] configuration.
  Tool({
    List<FunctionDeclaration>? functionDeclarations,
  })  : _rawJsonOverride = null,
        functionDeclarations = functionDeclarations != null
            ? List<FunctionDeclaration>.unmodifiable(functionDeclarations)
            : null;

  /// Creates a [Tool] exposing [functionDeclarations] for Gemini function calling.
  factory Tool.functionDeclarations(
    List<FunctionDeclaration> functionDeclarations,
  ) {
    return Tool(functionDeclarations: functionDeclarations);
  }

  /// Serializes this [Tool] to Gemini wire JSON.
  Map<String, dynamic> toJson() {
    if (_rawJsonOverride != null) {
      return Map<String, dynamic>.from(_rawJsonOverride);
    }
    final json = <String, dynamic>{};
    if (functionDeclarations != null) {
      json['functionDeclarations'] =
          functionDeclarations!.map((decl) => decl.toJson()).toList();
    }
    return json;
  }
}

/// Policy controlling how Gemini selects and invokes declared tool functions.
class FunctionCallingConfig {
  final FunctionCallingMode? mode;
  final Set<String>? allowedFunctionNames;

  /// Creates a [FunctionCallingConfig] with optional [mode] and [allowedFunctionNames].
  FunctionCallingConfig({
    this.mode,
    Iterable<String>? allowedFunctionNames,
  }) : allowedFunctionNames = allowedFunctionNames != null
            ? Set<String>.unmodifiable(allowedFunctionNames)
            : null;

  /// Model decides automatically between text output and function calls (`AUTO`).
  factory FunctionCallingConfig.auto() {
    return FunctionCallingConfig(mode: FunctionCallingMode.auto);
  }

  /// Forces the model to emit a function call (`ANY`), optionally restricted to [allowedFunctionNames].
  factory FunctionCallingConfig.any([Iterable<String>? allowedFunctionNames]) {
    return FunctionCallingConfig(
      mode: FunctionCallingMode.any,
      allowedFunctionNames: allowedFunctionNames,
    );
  }

  /// Disables function calling (`NONE`).
  factory FunctionCallingConfig.none() {
    return FunctionCallingConfig(mode: FunctionCallingMode.none);
  }

  /// Serializes this [FunctionCallingConfig] to Gemini wire JSON.
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{};
    if (mode != null) {
      json['mode'] = mode!.toJson();
    }
    if (allowedFunctionNames != null && allowedFunctionNames!.isNotEmpty) {
      json['allowedFunctionNames'] = allowedFunctionNames!.toList();
    }
    return json;
  }
}

/// Wrapper configuration for tool calling behavior passed to `GenerativeModel` or requests.
class ToolConfig {
  final FunctionCallingConfig? functionCallingConfig;
  final Map<String, dynamic>? _rawJsonOverride;

  /// Creates a [ToolConfig] from a pre-serialized wire JSON map.
  ToolConfig.fromJsonMap(Map<String, dynamic> json)
      : _rawJsonOverride = Map<String, dynamic>.unmodifiable(json),
        functionCallingConfig = null;

  const ToolConfig({
    this.functionCallingConfig,
  }) : _rawJsonOverride = null;

  /// Serializes this [ToolConfig] to Gemini wire JSON.
  Map<String, dynamic> toJson() {
    if (_rawJsonOverride != null) {
      return Map<String, dynamic>.from(_rawJsonOverride);
    }
    final json = <String, dynamic>{};
    if (functionCallingConfig != null) {
      json['functionCallingConfig'] = functionCallingConfig!.toJson();
    }
    return json;
  }
}
