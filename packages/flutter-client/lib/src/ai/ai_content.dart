import 'dart:convert';
import 'dart:typed_data';

/// A single typed datum inside a [Content] message on the Gemini wire.
sealed class Part {
  const Part();

  /// Serializes this part to its Gemini v1beta JSON wire object.
  Map<String, dynamic> toJson();
}

/// Plain text content part.
final class TextPart extends Part {
  final String text;
  final String? thoughtSignature;

  const TextPart(this.text, {this.thoughtSignature});

  @override
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'text': text,
      if (thoughtSignature != null) 'thoughtSignature': thoughtSignature,
    };
  }
}

/// Model reasoning / thought summary part (`thought: true` on the Gemini wire).
final class ThoughtPart extends Part {
  final String text;
  final String? thoughtSignature;

  const ThoughtPart(this.text, {this.thoughtSignature});

  @override
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'text': text,
      'thought': true,
      if (thoughtSignature != null) 'thoughtSignature': thoughtSignature,
    };
  }
}

/// Inline binary media part encoded as base64 on the Gemini wire.
final class InlineDataPart extends Part {
  final String mimeType;
  final Uint8List bytes;
  final bool? willContinue;
  final String? thoughtSignature;

  const InlineDataPart(
    this.mimeType,
    this.bytes, {
    this.willContinue,
    this.thoughtSignature,
  });

  @override
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'inlineData': <String, dynamic>{
        'mimeType': mimeType,
        'data': base64Encode(bytes),
        if (willContinue != null) 'willContinue': willContinue,
      },
      if (thoughtSignature != null) 'thoughtSignature': thoughtSignature,
    };
  }
}

/// Reference to an uploaded or Cloud Storage media URI (`fileData`).
final class FileData extends Part {
  final String mimeType;
  final String fileUri;
  final String? thoughtSignature;

  const FileData(this.mimeType, this.fileUri, {this.thoughtSignature});

  @override
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'fileData': <String, dynamic>{
        'mimeType': mimeType,
        'fileUri': fileUri,
      },
      if (thoughtSignature != null) 'thoughtSignature': thoughtSignature,
    };
  }
}

/// Structured tool invocation requested by the model.
///
/// Preserves [thoughtSignature] when present so multi-turn model history
/// satisfies Gemini's required signature check on replayed function calls.
final class FunctionCall extends Part {
  final String name;
  final Map<String, Object?> args;
  final String? id;
  final String? thoughtSignature;

  FunctionCall(
    this.name,
    Map<String, Object?> args, {
    this.id,
    this.thoughtSignature,
  }) : args = Map<String, Object?>.unmodifiable(args);

  @override
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'functionCall': <String, dynamic>{
        'name': name,
        'args': Map<String, dynamic>.from(args),
        if (id != null) 'id': id,
      },
      if (thoughtSignature != null) 'thoughtSignature': thoughtSignature,
    };
  }
}

/// Result returned by the application after executing a [FunctionCall].
final class FunctionResponse extends Part {
  final String name;
  final Map<String, Object?> response;
  final String? id;

  FunctionResponse(
    this.name,
    Map<String, Object?> response, {
    this.id,
  }) : response = Map<String, Object?>.unmodifiable(response);

  @override
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'functionResponse': <String, dynamic>{
        'name': name,
        'response': Map<String, dynamic>.from(response),
        if (id != null) 'id': id,
      },
    };
  }
}

/// Forward-compatible wrapper for unrecognized wire part objects.
final class UnknownPart extends Part {
  final Map<String, dynamic> raw;

  UnknownPart(Map<String, dynamic> raw)
      : raw = Map<String, dynamic>.unmodifiable(raw);

  @override
  Map<String, dynamic> toJson() => Map<String, dynamic>.from(raw);
}

/// A single turn of multi-part content in a Gemini prompt, response, or chat.
final class Content {
  /// Producer role (`user`, `model`, `system`), or `null` when unspecified.
  final String? role;

  /// Ordered parts carried by this turn.
  final List<Part> parts;

  Content(this.role, Iterable<Part> parts)
      : parts = List<Part>.unmodifiable(parts);

  /// Single-part `user` text turn.
  factory Content.text(String text) => Content('user', <Part>[TextPart(text)]);

  /// Single-part `user` inline binary data turn.
  factory Content.data(String mimeType, Uint8List bytes) =>
      Content('user', <Part>[InlineDataPart(mimeType, bytes)]);

  /// Multi-part `user` turn combining text, inline media, or file references.
  factory Content.multi(Iterable<Part> parts) => Content('user', parts);

  /// Multi-part `model` turn.
  factory Content.model(Iterable<Part> parts) => Content('model', parts);

  /// System instruction content (`system` role).
  factory Content.system(String instructions) =>
      Content('system', <Part>[TextPart(instructions)]);

  /// Single tool execution result turn (`user` role per Gemini v1beta wire).
  factory Content.functionResponse(
    String name,
    Map<String, Object?> response, {
    String? id,
  }) =>
      Content('user', <Part>[FunctionResponse(name, response, id: id)]);

  /// Batched tool execution result turn (`user` role per Gemini v1beta wire).
  factory Content.functionResponses(Iterable<FunctionResponse> responses) =>
      Content('user', responses);

  /// Serializes this content turn to its Gemini wire JSON map.
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      if (role != null) 'role': role,
      'parts': parts.map((part) => part.toJson()).toList(growable: false),
    };
  }
}
