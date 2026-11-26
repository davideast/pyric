import 'dart:async';

import '../transport/bridge_client.dart';

const _infoSegment = '.info';

/// Reports whether [path] is under `/.info`: its first segment is `.info`.
bool isInfoPath(String path) {
  final segments = _segmentsOf(path);
  return segments.isNotEmpty && segments.first == _infoSegment;
}

List<String> _segmentsOf(String path) =>
    path.split('/').where((segment) => segment.isNotEmpty).toList();

/// Serves `/.info` from the bridge connection, as every production SDK keeps
/// it client-side (ADR-0019, amendment of 2026-10-16). Nothing under `/.info`
/// reaches the host or is replayed on re-attach.
///
/// `connected` is true while the bridge is attached and this database's
/// network flag is on. The bridge sends an operation issued from the `true`
/// callback after the Auth restore, the listener replay and the held
/// operations, so a presence re-arm reaches the new connection after them.
class ConnectionInfo {
  final PyricBridgeClient _bridgeClient;
  final List<void Function()> _networkListeners = [];
  bool _notifyingNetwork = false;
  bool _networkDirty = false;
  bool _isOnline = true;

  ConnectionInfo(this._bridgeClient);

  /// Whether this database is connected to the host.
  bool get isConnected => _connectedIn(_bridgeClient.connectionState);

  bool _connectedIn(BridgeConnectionState state) {
    final isAttached = state == BridgeConnectionState.attached;
    return isAttached && _isOnline;
  }

  /// Sets this database's network flag, as `goOffline()` and `goOnline()` do.
  void setOnline(bool isOnline) {
    if (_isOnline == isOnline) return;
    _isOnline = isOnline;
    if (_notifyingNetwork) {
      _networkDirty = true;
      return;
    }
    _notifyingNetwork = true;
    try {
      do {
        _networkDirty = false;
        final snapshot = List<void Function()>.of(_networkListeners);
        for (final listener in snapshot) {
          if (_networkListeners.contains(listener)) {
            listener();
          }
        }
      } while (_networkDirty);
    } finally {
      _notifyingNetwork = false;
    }
  }

  /// The current value of `connected`, then each change. Repeated values are
  /// not delivered. Listening starts the first connection, as a host listener
  /// does, and ends when the bridge client closes.
  Stream<bool> connectedChanges() {
    return Stream<bool>.multi((listener) {
      if (_bridgeClient.isDisposed) {
        listener.close();
        return;
      }

      var hasDelivered = false;
      var lastDelivered = false;
      var delivering = false;
      var pendingDeliver = false;
      var pendingValue = false;

      void deliverSync(bool next) {
        if (listener.isClosed) return;
        if (delivering) {
          pendingDeliver = true;
          pendingValue = next;
          return;
        }
        delivering = true;
        try {
          var candidate = next;
          while (true) {
            if (listener.isClosed) return;
            if (!hasDelivered || candidate != lastDelivered) {
              hasDelivered = true;
              lastDelivered = candidate;
              listener.addSync(candidate);
            }
            if (!pendingDeliver) break;
            pendingDeliver = false;
            candidate = pendingValue;
          }
        } finally {
          delivering = false;
        }
      }

      late final StreamSubscription<BridgeConnectionState> stateSub;
      void onNetworkChanged() => deliverSync(isConnected);

      void closeNow() {
        _networkListeners.remove(onNetworkChanged);
        unawaited(stateSub.cancel());
        if (!listener.isClosed) {
          listener.closeSync();
        }
      }

      stateSub = _bridgeClient.connectionStates.listen(
        (state) => deliverSync(_connectedIn(state)),
        onDone: closeNow,
      );
      _networkListeners.add(onNetworkChanged);
      listener.onCancel = () {
        _networkListeners.remove(onNetworkChanged);
        unawaited(stateSub.cancel());
      };

      scheduleMicrotask(() {
        if (listener.isClosed || _bridgeClient.isDisposed || hasDelivered) {
          return;
        }
        deliverSync(isConnected);
      });
      _bridgeClient.connect().ignore();
    });
  }

  /// The wire snapshot of [path] now.
  Map<String, dynamic> read(String path) => _snapshotOf(path, isConnected);

  /// The wire snapshot of [path] now, then on each change of `connected`.
  Stream<dynamic> watch(String path) {
    return connectedChanges().map((connected) => _snapshotOf(path, connected));
  }

  static Map<String, dynamic> _snapshotOf(String path, bool connected) {
    final value = _valueAt(_segmentsOf(path).skip(1).toList(), connected);
    return {'exists': value != null, 'value': value};
  }

  static Object? _valueAt(List<String> infoSegments, bool connected) {
    final isRoot = infoSegments.isEmpty;
    if (isRoot) return {'connected': connected, 'serverTimeOffset': 0};
    final isLeaf = infoSegments.length == 1;
    if (!isLeaf) return null;
    switch (infoSegments.single) {
      case 'connected':
        return connected;
      case 'serverTimeOffset':
        return 0;
      default:
        return null;
    }
  }
}
