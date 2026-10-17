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
  final StreamController<void> _networkChanges =
      StreamController<void>.broadcast(sync: true);
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
    _networkChanges.add(null);
  }

  /// The current value of `connected`, then each change. Repeated values are
  /// not delivered. Listening starts the first connection, as a host listener
  /// does.
  Stream<bool> connectedChanges() {
    return Stream<bool>.multi((listener) {
      final stateSub = _bridgeClient.connectionStates.listen((state) {
        listener.add(_connectedIn(state));
      });
      final networkSub = _networkChanges.stream.listen((_) {
        listener.add(isConnected);
      });
      listener.onCancel = () async {
        await stateSub.cancel();
        await networkSub.cancel();
      };
      listener.add(isConnected);
      _bridgeClient.connect().ignore();
    }).distinct();
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
