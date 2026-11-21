import 'dart:async';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

import 'storage_wire_codec.dart';

class _TaskCanceledSignal implements Exception {
  const _TaskCanceledSignal();
}

/// Terminal payload returned by a transfer runner when a [PyricTaskPlatform] succeeds.
class CompletedTaskPayload {
  final int bytesTransferred;
  final int totalBytes;
  final FullMetadata? metadata;
  final Map<String, dynamic>? metadataMap;

  const CompletedTaskPayload({
    required this.bytesTransferred,
    required this.totalBytes,
    this.metadata,
    this.metadataMap,
  });
}

/// Concrete [TaskSnapshotPlatform] exposing [ref], byte progress, [state], and [metadata].
class PyricTaskSnapshotPlatform extends TaskSnapshotPlatform {
  final ReferencePlatform _ref;
  final FullMetadata? _metadataOverride;

  PyricTaskSnapshotPlatform({
    required ReferencePlatform ref,
    required TaskState state,
    required int bytesTransferred,
    required int totalBytes,
    Map<String, dynamic>? metadataMap,
    FullMetadata? metadata,
  })  : _ref = ref,
        _metadataOverride = metadata,
        super(
          state,
          <String, dynamic>{
            'path': ref.fullPath,
            'bytesTransferred': bytesTransferred,
            'totalBytes': totalBytes,
            if (metadataMap != null) 'metadata': metadataMap,
          },
        );

  @override
  ReferencePlatform get ref => _ref;

  @override
  FullMetadata? get metadata => _metadataOverride ?? super.metadata;
}

/// Execution handle supplied to an upload or download runner driving a [PyricTaskPlatform].
class PyricTaskExecutionContext {
  final PyricTaskPlatform _task;

  PyricTaskExecutionContext._(this._task);

  /// Whether this task has entered a terminal state (`canceled`, `error`, or `success`).
  bool get isCanceled => _task._state == TaskState.canceled;

  /// Whether this task is currently paused.
  bool get isPaused => _task._state == TaskState.paused;

  /// Latest transferred byte count.
  int get bytesTransferred => _task._bytesTransferred;

  /// Latest total byte count.
  int get totalBytes => _task._totalBytes;

  /// Updates the total expected byte count once resolved (for example from file or object metadata).
  void updateTotalBytes(int totalBytes) {
    if (_task._isTerminal) {
      return;
    }
    _task._totalBytes = totalBytes;
    _task._snapshot = PyricTaskSnapshotPlatform(
      ref: _task._ref,
      state: _task._state,
      bytesTransferred: _task._bytesTransferred,
      totalBytes: _task._totalBytes,
    );
  }

  /// Reports chunk progress and emits a [TaskState.running] snapshot when active.
  void reportProgress(int bytesTransferred, {int? totalBytes}) {
    if (_task._isTerminal) {
      return;
    }
    _task._bytesTransferred = bytesTransferred;
    if (totalBytes != null) {
      _task._totalBytes = totalBytes;
    }
    _task._snapshot = PyricTaskSnapshotPlatform(
      ref: _task._ref,
      state: _task._state,
      bytesTransferred: _task._bytesTransferred,
      totalBytes: _task._totalBytes,
    );
    if (_task._state == TaskState.running && !_task._controller.isClosed) {
      _task._controller.add(_task._snapshot);
    }
  }

  /// Suspends execution while [isPaused] and throws an internal signal if canceled.
  Future<void> waitUntilRunningOrThrowCanceled() async {
    while (_task._state == TaskState.paused && !_task._isTerminal) {
      final gate = _task._resumeGate;
      if (gate != null && !gate.isCompleted) {
        await gate.future;
      } else {
        break;
      }
    }
    if (_task._isTerminal) {
      throw const _TaskCanceledSignal();
    }
  }

  /// Registers a cleanup callback invoked if [PyricTaskPlatform.cancel] or disposal occurs.
  void setCancelCleanup(Future<void> Function()? cleanup) {
    _task._cancelCleanup = cleanup;
  }
}

/// Concrete [TaskPlatform] driving chunked Storage uploads and file downloads with pause/resume/cancel.
class PyricTaskPlatform extends TaskPlatform {
  final ReferencePlatform _ref;
  final void Function(PyricTaskPlatform task)? _onUnregister;
  final StreamController<TaskSnapshotPlatform> _controller =
      StreamController<TaskSnapshotPlatform>.broadcast();
  final Completer<TaskSnapshotPlatform> _onCompleteCompleter =
      Completer<TaskSnapshotPlatform>();

  late PyricTaskSnapshotPlatform _snapshot;
  late final PyricTaskExecutionContext _context;

  TaskState _state = TaskState.running;
  int _bytesTransferred = 0;
  int _totalBytes;
  bool _isTerminal = false;
  Completer<void>? _resumeGate;
  Future<void> Function()? _cancelCleanup;

  PyricTaskPlatform({
    required ReferencePlatform ref,
    required int initialTotalBytes,
    required Future<CompletedTaskPayload> Function(PyricTaskExecutionContext ctx)
        runner,
    void Function(PyricTaskPlatform task)? onRegister,
    void Function(PyricTaskPlatform task)? onUnregister,
  })  : _ref = ref,
        _totalBytes = initialTotalBytes,
        _onUnregister = onUnregister,
        super() {
    // Prevent unhandled zone errors when callers listen only to snapshotEvents
    // (or cancel without awaiting onComplete).
    _onCompleteCompleter.future.ignore();

    _snapshot = PyricTaskSnapshotPlatform(
      ref: _ref,
      state: TaskState.running,
      bytesTransferred: 0,
      totalBytes: initialTotalBytes,
    );
    _context = PyricTaskExecutionContext._(this);
    onRegister?.call(this);
    scheduleMicrotask(() {
      unawaited(_execute(runner));
    });
  }

  @override
  Stream<TaskSnapshotPlatform> get snapshotEvents => _controller.stream;

  @override
  TaskSnapshotPlatform get snapshot => _snapshot;

  @override
  Future<TaskSnapshotPlatform> get onComplete => _onCompleteCompleter.future;

  @override
  Future<bool> pause() async {
    if (_isTerminal || _state != TaskState.running) {
      return false;
    }
    _state = TaskState.paused;
    _resumeGate = Completer<void>();
    _snapshot = PyricTaskSnapshotPlatform(
      ref: _ref,
      state: TaskState.paused,
      bytesTransferred: _bytesTransferred,
      totalBytes: _totalBytes,
    );
    if (!_controller.isClosed) {
      _controller.add(_snapshot);
    }
    return true;
  }

  @override
  Future<bool> resume() async {
    if (_isTerminal || _state != TaskState.paused) {
      return false;
    }
    _state = TaskState.running;
    _snapshot = PyricTaskSnapshotPlatform(
      ref: _ref,
      state: TaskState.running,
      bytesTransferred: _bytesTransferred,
      totalBytes: _totalBytes,
    );
    if (!_controller.isClosed) {
      _controller.add(_snapshot);
    }
    final gate = _resumeGate;
    _resumeGate = null;
    if (gate != null && !gate.isCompleted) {
      gate.complete();
    }
    return true;
  }

  @override
  Future<bool> cancel() async {
    if (_isTerminal) {
      return false;
    }
    _isTerminal = true;
    _state = TaskState.canceled;
    _snapshot = PyricTaskSnapshotPlatform(
      ref: _ref,
      state: TaskState.canceled,
      bytesTransferred: _bytesTransferred,
      totalBytes: _totalBytes,
    );

    final gate = _resumeGate;
    _resumeGate = null;
    if (gate != null && !gate.isCompleted) {
      gate.complete();
    }

    final cleanup = _cancelCleanup;
    _cancelCleanup = null;
    if (cleanup != null) {
      try {
        await cleanup();
      } catch (_) {
        // Best-effort abort/rollback cleanup when canceling.
      }
    }

    final canceledException = FirebaseException(
      plugin: 'firebase_storage',
      code: 'canceled',
      message: 'User canceled the Storage transfer task.',
    );
    if (!_controller.isClosed && _controller.hasListener) {
      _controller.addError(canceledException);
    }
    if (!_onCompleteCompleter.isCompleted) {
      _onCompleteCompleter.completeError(canceledException);
    }
    await _closeControllerSafely();
    return true;
  }

  /// Cancels and closes this task when the owning [PyricFirebaseStoragePlatform] is disposed.
  Future<void> disposeTask() async {
    if (_isTerminal) {
      await _closeControllerSafely();
      return;
    }
    await cancel();
  }

  Future<void> _execute(
    Future<CompletedTaskPayload> Function(PyricTaskExecutionContext ctx) runner,
  ) async {
    try {
      if (_isTerminal) {
        return;
      }
      if (_state == TaskState.running && !_controller.isClosed) {
        _controller.add(_snapshot);
      }
      await _context.waitUntilRunningOrThrowCanceled();

      final completed = await runner(_context);
      await _context.waitUntilRunningOrThrowCanceled();

      _isTerminal = true;
      _cancelCleanup = null;
      _state = TaskState.success;
      _bytesTransferred = completed.bytesTransferred;
      _totalBytes = completed.totalBytes;
      _snapshot = PyricTaskSnapshotPlatform(
        ref: _ref,
        state: TaskState.success,
        bytesTransferred: completed.bytesTransferred,
        totalBytes: completed.totalBytes,
        metadataMap: completed.metadataMap,
        metadata: completed.metadata,
      );
      if (!_controller.isClosed) {
        _controller.add(_snapshot);
      }
      if (!_onCompleteCompleter.isCompleted) {
        _onCompleteCompleter.complete(_snapshot);
      }
      await _closeControllerSafely();
    } on _TaskCanceledSignal {
      await _closeControllerSafely();
    } catch (error, stackTrace) {
      if (_isTerminal) {
        await _closeControllerSafely();
        return;
      }
      _isTerminal = true;
      _cancelCleanup = null;
      _state = TaskState.error;
      final firebaseException = mapToStorageFirebaseException(error, stackTrace);
      _snapshot = PyricTaskSnapshotPlatform(
        ref: _ref,
        state: TaskState.error,
        bytesTransferred: _bytesTransferred,
        totalBytes: _totalBytes,
      );
      if (!_controller.isClosed && _controller.hasListener) {
        _controller.addError(firebaseException, stackTrace);
      }
      if (!_onCompleteCompleter.isCompleted) {
        _onCompleteCompleter.completeError(firebaseException, stackTrace);
      }
      await _closeControllerSafely();
    } finally {
      _onUnregister?.call(this);
    }
  }

  Future<void> _closeControllerSafely() async {
    if (!_controller.isClosed) {
      await _controller.close();
    }
  }
}
