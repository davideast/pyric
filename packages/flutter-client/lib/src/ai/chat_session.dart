import 'dart:async';

import 'ai_config.dart';
import 'ai_content.dart';
import 'ai_exception.dart';
import 'ai_response.dart';
import 'generative_model.dart';

Content _normalizeChatTurn(Content turn) {
  final rawRole = turn.role;
  String resolvedRole;
  if (rawRole == null || rawRole.isEmpty) {
    resolvedRole = 'user';
  } else if (rawRole == 'function' &&
      turn.parts.isNotEmpty &&
      turn.parts.every((part) => part is FunctionResponse)) {
    resolvedRole = 'user';
  } else {
    resolvedRole = rawRole;
  }
  return Content(resolvedRole, List<Part>.of(turn.parts));
}

Content? _extractRecordableModelTurn(GenerateContentResponse response) {
  if (response.promptFeedback?.blockReason != null) {
    return null;
  }
  if (response.candidates.isEmpty) {
    return null;
  }
  final first = response.candidates.first;
  if (first.finishReason?.isBlocked ?? false) {
    return null;
  }
  if (first.content.parts.isEmpty) {
    return null;
  }
  final resolvedRole =
      (first.content.role == null || first.content.role!.isEmpty)
          ? 'model'
          : first.content.role!;
  return Content(resolvedRole, List<Part>.of(first.content.parts));
}

Content? _aggregateStreamedModelTurn(List<GenerateContentResponse> chunks) {
  if (chunks.isEmpty) {
    return null;
  }
  for (final chunk in chunks) {
    if (chunk.promptFeedback?.blockReason != null) {
      return null;
    }
    if (chunk.candidates.isNotEmpty &&
        (chunk.candidates.first.finishReason?.isBlocked ?? false)) {
      return null;
    }
  }

  var resolvedRole = 'model';
  final mergedParts = <Part>[];
  for (final chunk in chunks) {
    if (chunk.candidates.isEmpty) {
      continue;
    }
    final candidate = chunk.candidates.first;
    final candidateRole = candidate.content.role;
    if (candidateRole != null && candidateRole.isNotEmpty) {
      resolvedRole = candidateRole;
    }
    for (final part in candidate.content.parts) {
      if (part is TextPart) {
        if (mergedParts.isNotEmpty && mergedParts.last is TextPart) {
          final previous = mergedParts.last as TextPart;
          mergedParts[mergedParts.length - 1] = TextPart(
            previous.text + part.text,
            thoughtSignature: part.thoughtSignature ?? previous.thoughtSignature,
          );
        } else if (part.text.isNotEmpty) {
          mergedParts.add(part);
        }
      } else if (part is ThoughtPart) {
        if (mergedParts.isNotEmpty && mergedParts.last is ThoughtPart) {
          final previous = mergedParts.last as ThoughtPart;
          mergedParts[mergedParts.length - 1] = ThoughtPart(
            previous.text + part.text,
            thoughtSignature: part.thoughtSignature ?? previous.thoughtSignature,
          );
        } else if (part.text.isNotEmpty) {
          mergedParts.add(part);
        }
      } else {
        mergedParts.add(part);
      }
    }
  }

  if (mergedParts.isEmpty) {
    return null;
  }
  return Content(resolvedRole, mergedParts);
}

/// Stateful multi-turn Gemini conversation session created by [GenerativeModel.startChat].
///
/// Serializes turns in FIFO call order, atomically records user and model turns
/// only when a non-blocked response finishes cleanly, rolls back / excludes
/// blocked, cancelled, or errored turns without mutating [history], and
/// preserves `thoughtSignature` across multi-turn [FunctionCall] /
/// [FunctionResponse] tool round-trips.
final class ChatSession {
  final GenerativeModel _model;
  final List<Content> _history;
  final List<SafetySetting>? _safetySettings;
  final GenerationConfig? _generationConfig;
  final List<Tool>? _tools;
  final ToolConfig? _toolConfig;

  Future<void> _turnQueue = Future<void>.value();

  ChatSession({
    required GenerativeModel model,
    List<Content>? history,
    List<SafetySetting>? safetySettings,
    GenerationConfig? generationConfig,
    List<Tool>? tools,
    ToolConfig? toolConfig,
  })  : _model = model,
        _history = <Content>[
          if (history != null)
            for (final turn in history) _normalizeChatTurn(turn),
        ],
        _safetySettings = safetySettings == null
            ? null
            : List<SafetySetting>.unmodifiable(safetySettings),
        _generationConfig = generationConfig,
        _tools = tools == null ? null : List<Tool>.unmodifiable(tools),
        _toolConfig = toolConfig {
    _generationConfig?.validate();
  }

  /// Chronological, unmodifiable snapshot of completed non-blocked turns.
  Iterable<Content> get history => List<Content>.unmodifiable(_history);

  Future<T> _enqueueTurn<T>(Future<T> Function() action) {
    final previous = _turnQueue;
    final done = Completer<void>();
    _turnQueue = done.future;
    return previous.then((_) async {
      try {
        return await action();
      } finally {
        if (!done.isCompleted) {
          done.complete();
        }
      }
    });
  }

  /// Sends [message] with prior [history] via `ai.generateContent` and appends
  /// both turns to [history] if and only if the response succeeds unblocked.
  Future<GenerateContentResponse> sendMessage(Content message) {
    return _enqueueTurn<GenerateContentResponse>(() async {
      final userTurn = _normalizeChatTurn(message);
      if (userTurn.parts.isEmpty) {
        throw const FirebaseAIException(
          'Chat message Content must contain at least one Part.',
          code: 'invalid-argument',
        );
      }
      final requestContents = <Content>[..._history, userTurn];
      final response = await _model.generateContent(
        requestContents,
        safetySettings: _safetySettings,
        generationConfig: _generationConfig,
        tools: _tools,
        toolConfig: _toolConfig,
      );
      final modelTurn = _extractRecordableModelTurn(response);
      if (modelTurn != null) {
        _history.add(userTurn);
        _history.add(modelTurn);
      }
      return response;
    });
  }

  /// Streams the response for [message] via `ai.streamGenerateContent` and
  /// atomically appends the user turn plus aggregated model turn upon clean,
  /// non-blocked stream completion.
  ///
  /// Mid-stream errors, blocked chunks, or consumer `StreamSubscription.cancel()`
  /// leave [history] untouched and release the session queue cleanly.
  Stream<GenerateContentResponse> sendMessageStream(Content message) {
    final previousTurn = _turnQueue;
    final turnDone = Completer<void>();
    _turnQueue = turnDone.future;

    void releaseTurn() {
      if (!turnDone.isCompleted) {
        turnDone.complete();
      }
    }

    late final StreamController<GenerateContentResponse> controller;
    StreamSubscription<GenerateContentResponse>? innerSub;
    final collectedChunks = <GenerateContentResponse>[];
    var isCancelled = false;
    var isSettled = false;

    controller = StreamController<GenerateContentResponse>(
      onListen: () {
        Future<void>(() async {
          await previousTurn;
          if (isCancelled || isSettled) {
            releaseTurn();
            return;
          }

          final Content userTurn;
          try {
            userTurn = _normalizeChatTurn(message);
            if (userTurn.parts.isEmpty) {
              throw const FirebaseAIException(
                'Chat message Content must contain at least one Part.',
                code: 'invalid-argument',
              );
            }
          } catch (error, stackTrace) {
            isSettled = true;
            releaseTurn();
            if (!controller.isClosed) {
              controller.addError(
                mapBridgeErrorToFirebaseAIException(error),
                stackTrace,
              );
              await controller.close();
            }
            return;
          }

          final requestContents = <Content>[..._history, userTurn];
          final responseStream = _model.generateContentStream(
            requestContents,
            safetySettings: _safetySettings,
            generationConfig: _generationConfig,
            tools: _tools,
            toolConfig: _toolConfig,
          );

          innerSub = responseStream.listen(
            (GenerateContentResponse chunk) {
              if (isCancelled || isSettled || controller.isClosed) {
                return;
              }
              collectedChunks.add(chunk);
              controller.add(chunk);
            },
            onError: (Object error, StackTrace stackTrace) {
              if (isCancelled || isSettled) {
                return;
              }
              isSettled = true;
              final active = innerSub;
              innerSub = null;
              unawaited(active?.cancel());
              releaseTurn();
              if (!controller.isClosed) {
                controller.addError(
                  mapBridgeErrorToFirebaseAIException(error),
                  stackTrace,
                );
                unawaited(controller.close());
              }
            },
            onDone: () {
              if (isCancelled || isSettled) {
                return;
              }
              isSettled = true;
              innerSub = null;
              final aggregatedModelTurn =
                  _aggregateStreamedModelTurn(collectedChunks);
              if (aggregatedModelTurn != null) {
                _history.add(userTurn);
                _history.add(aggregatedModelTurn);
              }
              releaseTurn();
              if (!controller.isClosed) {
                unawaited(controller.close());
              }
            },
            cancelOnError: true,
          );

          if (controller.isPaused) {
            innerSub?.pause();
          }
        });
      },
      onPause: () {
        innerSub?.pause();
      },
      onResume: () {
        innerSub?.resume();
      },
      onCancel: () async {
        isCancelled = true;
        isSettled = true;
        final active = innerSub;
        innerSub = null;
        try {
          if (active != null) {
            await active.cancel();
          }
        } finally {
          releaseTurn();
        }
      },
    );

    return controller.stream;
  }
}
