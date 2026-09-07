import 'dart:async';
import 'dart:convert';

import 'package:collection/collection.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:pyric_firestore/src/auth/auth_lens.dart';
import 'package:pyric_firestore/src/auth/pyric_auth_credentials_provider.dart';
import 'package:pyric_firestore/src/transport/bridge_client.dart';
import 'package:pyric_firestore/src/database/pyric_database.dart';

class _MockWebSocketChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> toServer;
  final StreamController<dynamic> toClient;

  _MockWebSocketChannel({required this.toServer, required this.toClient});

  @override
  Stream<dynamic> get stream => toClient.stream;

  @override
  WebSocketSink get sink => _MockWebSocketSink(toServer);

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => Future.value();
}

class _MockWebSocketSink implements WebSocketSink {
  final StreamController<dynamic> _controller;
  _MockWebSocketSink(this._controller);

  @override
  void add(dynamic data) => _controller.add(data);

  @override
  void addError(Object error, [StackTrace? st]) => _controller.addError(error, st);

  @override
  Future<void> addStream(Stream<dynamic> s) => _controller.addStream(s);

  @override
  Future<void> close([int? closeCode, String? closeReason]) => _controller.close();

  @override
  Future<void> get done => _controller.done;
}

class _TreeNode {
  Object? value;
  Object? priority;
  final Map<String, _TreeNode> children = {};

  bool get isEmpty => value == null && children.isEmpty;

  Object? toPlainValue() {
    if (children.isNotEmpty) {
      final map = <String, dynamic>{};
      for (final entry in children.entries) {
        final v = entry.value.toPlainValue();
        if (v != null) {
          map[entry.key] = v;
        }
      }
      return map.isEmpty ? null : map;
    }
    return value;
  }
}

class _DisconnectOp {
  final String kind; // 'set', 'update', 'remove'
  final String path;
  final Object? value;
  final Object? priority;
  final Map<String, dynamic>? values;

  _DisconnectOp({
    required this.kind,
    required this.path,
    this.value,
    this.priority,
    this.values,
  });
}

/// Mock credentials provider allowing tests to dynamically switch [AuthLens].
class MockRtdbCredentialsProvider implements PyricAuthCredentialsProvider {
  AuthLens _lens = AuthLens.anon;
  final StreamController<AuthLens> _controller =
      StreamController<AuthLens>.broadcast();

  @override
  AuthLens get currentAuthLens => _lens;

  @override
  Stream<AuthLens> get authLensChanges => _controller.stream;

  void setLens(AuthLens lens) {
    _lens = lens;
    _controller.add(lens);
  }

  Future<void> dispose() async {
    await _controller.close();
  }
}

/// Hermetic stateful RTDB worker harness over [PyricBridgeClient].
class RtdbTestHarness {
  final StreamController<dynamic> toServer = StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClient = StreamController<dynamic>.broadcast();
  final _TreeNode _root = _TreeNode();
  final Map<String, _DisconnectOp> _disconnectQueue = {};
  final Map<String, Map<String, dynamic>> _subs = {};

  final List<Map<String, dynamic>> receivedOps = [];
  final List<Map<String, dynamic>> receivedSubs = [];
  bool isOffline = false;

  late final PyricBridgeClient client;
  late final MockRtdbCredentialsProvider credentialsProvider;
  late final PyricDatabase database;

  RtdbTestHarness() {
    toServer.stream.listen(_handleServerMessage);
    final channel = _MockWebSocketChannel(
      toServer: toServer,
      toClient: toClient,
    );
    client = PyricBridgeClient(
      channelFactory: (uri, headers) => channel,
    );
    credentialsProvider = MockRtdbCredentialsProvider();
    database = PyricDatabase(
      bridgeClient: client,
      credentialsProvider: credentialsProvider,
    );
    PyricDatabase.registerWith(
      bridgeClient: client,
      credentialsProvider: credentialsProvider,
    );
  }

  Future<void> connect() => client.connect();

  Future<void> dispose() async {
    await credentialsProvider.dispose();
    await client.disconnect();
    await toServer.close();
    await toClient.close();
  }

  void _handleServerMessage(dynamic raw) {
    final msg = jsonDecode(raw as String) as Map<String, dynamic>;
    final type = msg['type'] as String?;

    if (type == 'attach') {
      toClient.add(jsonEncode({
        'type': 'attach-ack',
        'protocol': 1,
        'peerConnected': true,
      }));
    } else if (type == 'worker-op') {
      final id = msg['id'] as String;
      final op = Map<String, dynamic>.from(msg['op'] as Map);
      receivedOps.add(op);
      _handleOp(id, op);
    } else if (type == 'worker-sub') {
      final subId = msg['subId'] as String;
      final sub = Map<String, dynamic>.from(msg['sub'] as Map);
      receivedSubs.add(sub);
      _subs[subId] = sub;
      _emitSnapshot(subId, sub);
    } else if (type == 'worker-unsub') {
      final subId = msg['subId'] as String;
      _subs.remove(subId);
    }
  }

  void _handleOp(String id, Map<String, dynamic> op) {
    final method = op['method'] as String;
    final path = op['path'] as String? ?? '/';

    switch (method) {
      case 'rtdb.get':
        final query = op['query'] is Map
            ? Map<String, dynamic>.from(op['query'] as Map)
            : null;
        final snap = _buildWireSnapshot(path, query);
        _sendRes(id, snap);
        break;

      case 'rtdb.set':
        _setNode(path, op['value']);
        _notifySubs();
        _sendRes(id, null);
        break;

      case 'rtdb.setPriority':
        _setPriority(path, op['priority']);
        _notifySubs();
        _sendRes(id, null);
        break;

      case 'rtdb.setWithPriority':
        _setNode(path, op['value'], priority: op['priority']);
        _notifySubs();
        _sendRes(id, null);
        break;

      case 'rtdb.update':
        final values = Map<String, dynamic>.from(op['values'] as Map);
        for (final entry in values.entries) {
          final childPath = _joinPath(path, entry.key);
          _setNode(childPath, entry.value);
        }
        _notifySubs();
        _sendRes(id, null);
        break;

      case 'rtdb.remove':
        _setNode(path, null);
        _notifySubs();
        _sendRes(id, null);
        break;

      case 'rtdb.transactionCommit':
        final expected = op['expected'];
        final currentVal = _getNode(path).toPlainValue();
        const eq = DeepCollectionEquality();
        if (!eq.equals(currentVal, expected)) {
          _sendRes(id, {
            'retry': true,
            'committed': false,
            'snapshot': _buildWireSnapshot(path, null),
          });
        } else {
          _setNode(path, op['value']);
          _notifySubs();
          _sendRes(id, {
            'retry': false,
            'committed': true,
            'snapshot': _buildWireSnapshot(path, null),
          });
        }
        break;

      case 'rtdb.onDisconnectSet':
        _disconnectQueue[path] = _DisconnectOp(
          kind: 'set',
          path: path,
          value: op['value'],
          priority: op['priority'],
        );
        _sendRes(id, null);
        break;

      case 'rtdb.onDisconnectUpdate':
        _disconnectQueue[path] = _DisconnectOp(
          kind: 'update',
          path: path,
          values: Map<String, dynamic>.from(op['values'] as Map),
        );
        _sendRes(id, null);
        break;

      case 'rtdb.onDisconnectRemove':
        _disconnectQueue[path] = _DisconnectOp(
          kind: 'remove',
          path: path,
        );
        _sendRes(id, null);
        break;

      case 'rtdb.onDisconnectCancel':
        _disconnectQueue.remove(path);
        _sendRes(id, null);
        break;

      case 'rtdb.goOffline':
        isOffline = true;
        _drainDisconnects();
        _notifySubs();
        _sendRes(id, null);
        break;

      case 'rtdb.goOnline':
        isOffline = false;
        _sendRes(id, null);
        break;

      default:
        _sendRes(id, null);
        break;
    }
  }

  void _drainDisconnects() {
    for (final op in _disconnectQueue.values) {
      if (op.kind == 'set') {
        _setNode(op.path, op.value, priority: op.priority);
      } else if (op.kind == 'remove') {
        _setNode(op.path, null);
      } else if (op.kind == 'update' && op.values != null) {
        for (final entry in op.values!.entries) {
          _setNode(_joinPath(op.path, entry.key), entry.value);
        }
      }
    }
    _disconnectQueue.clear();
  }

  void _sendRes(String id, Object? value) {
    toClient.add(jsonEncode({
      'type': 'worker-res',
      'id': id,
      'ok': true,
      'value': value,
    }));
  }

  void _notifySubs() {
    for (final entry in _subs.entries) {
      _emitSnapshot(entry.key, entry.value);
    }
  }

  void _emitSnapshot(String subId, Map<String, dynamic> sub) {
    final target = Map<String, dynamic>.from(sub['target'] as Map);
    final path = target['path'] as String? ?? '/';
    final query = target['query'] is Map
        ? Map<String, dynamic>.from(target['query'] as Map)
        : null;
    final snap = _buildWireSnapshot(path, query);
    toClient.add(jsonEncode({
      'type': 'worker-snap',
      'subId': subId,
      'value': snap,
    }));
  }

  String _joinPath(String base, String child) {
    final segments = [
      ...base.split('/').where((s) => s.isNotEmpty),
      ...child.split('/').where((s) => s.isNotEmpty),
    ];
    return segments.isEmpty ? '/' : '/${segments.join('/')}';
  }

  _TreeNode _getNode(String path) {
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    _TreeNode current = _root;
    for (final seg in segments) {
      current = current.children.putIfAbsent(seg, () => _TreeNode());
    }
    return current;
  }

  void _setPriority(String path, Object? priority) {
    final node = _getNode(path);
    node.priority = priority;
  }

  void _setNode(String path, Object? rawValue, {Object? priority}) {
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    final currentVal = _getNode(path).toPlainValue();
    final resolved = _resolveSentinels(rawValue, currentVal);

    if (segments.isEmpty) {
      _root.children.clear();
      _root.value = null;
      _root.priority = priority;
      _populateNode(_root, resolved);
      return;
    }

    _TreeNode parent = _root;
    for (int i = 0; i < segments.length - 1; i++) {
      parent = parent.children.putIfAbsent(segments[i], () => _TreeNode());
    }

    final lastKey = segments.last;
    if (resolved == null) {
      parent.children.remove(lastKey);
    } else {
      final node = parent.children.putIfAbsent(lastKey, () => _TreeNode());
      node.children.clear();
      node.value = null;
      if (priority != null) node.priority = priority;
      _populateNode(node, resolved);
    }
  }

  void _populateNode(_TreeNode node, Object? value) {
    if (value is Map) {
      for (final entry in value.entries) {
        final k = entry.key.toString();
        final childNode = _TreeNode();
        _populateNode(childNode, entry.value);
        if (!childNode.isEmpty) {
          node.children[k] = childNode;
        }
      }
    } else {
      node.value = value;
    }
  }

  Object? _resolveSentinels(Object? value, Object? existingVal) {
    if (value is Map) {
      if (value['__rtdbSentinel'] == 'serverTimestamp' ||
          value['.sv'] == 'timestamp') {
        return DateTime.now().millisecondsSinceEpoch;
      }
      if (value['__rtdbSentinel'] == 'increment') {
        final delta = value['delta'] as num? ?? 0;
        final base = existingVal is num ? existingVal : 0;
        return base + delta;
      }
      if (value['.sv'] is Map && (value['.sv'] as Map).containsKey('increment')) {
        final delta = (value['.sv'] as Map)['increment'] as num? ?? 0;
        final base = existingVal is num ? existingVal : 0;
        return base + delta;
      }
      final out = <String, dynamic>{};
      for (final entry in value.entries) {
        final k = entry.key.toString();
        final existingChild = existingVal is Map ? existingVal[k] : null;
        out[k] = _resolveSentinels(entry.value, existingChild);
      }
      return out;
    }
    return value;
  }

  Map<String, dynamic> _buildWireSnapshot(
    String path,
    Map<String, dynamic>? query,
  ) {
    final node = _getNode(path);
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    final key = segments.isEmpty ? null : segments.last;

    var entries = <Map<String, dynamic>>[];
    for (final entry in node.children.entries) {
      final childVal = entry.value.toPlainValue();
      if (childVal != null) {
        entries.add({
          'key': entry.key,
          'value': childVal,
          'priority': entry.value.priority,
          'exportValue': childVal,
        });
      }
    }

    if (query != null) {
      entries = _applyQuery(entries, query);
    }

    final plainVal = entries.isNotEmpty
        ? {for (final e in entries) e['key'] as String: e['value']}
        : node.toPlainValue();

    return {
      'key': key,
      'exists': plainVal != null,
      'value': plainVal,
      'size': entries.length,
      'priority': node.priority,
      'exportValue': plainVal,
      'entries': entries,
    };
  }

  List<Map<String, dynamic>> _applyQuery(
    List<Map<String, dynamic>> entries,
    Map<String, dynamic> query,
  ) {
    final orderBy = query['orderBy'] is Map
        ? Map<String, dynamic>.from(query['orderBy'] as Map)
        : null;
    final kind = orderBy?['kind'] as String?;

    Comparable<dynamic> extractSortKey(Map<String, dynamic> entry) {
      if (kind == 'key') {
        return entry['key'] as String;
      } else if (kind == 'value') {
        final v = entry['value'];
        if (v is num) return v;
        if (v is String) return v;
        if (v is bool) return v ? 1 : 0;
        return '';
      } else if (kind == 'child') {
        final childPath = orderBy?['path'] as String? ?? '';
        Object? curr = entry['value'];
        for (final seg in childPath.split('/').where((s) => s.isNotEmpty)) {
          if (curr is Map) {
            curr = curr[seg];
          } else {
            curr = null;
            break;
          }
        }
        if (curr is num) return curr;
        if (curr is String) return curr;
        if (curr is bool) return curr ? 1 : 0;
        return '';
      } else {
        final prio = entry['priority'];
        if (prio is num) return prio;
        if (prio is String) return prio;
        return entry['key'] as String;
      }
    }

    final sorted = List<Map<String, dynamic>>.from(entries);
    sorted.sort((a, b) {
      final ka = extractSortKey(a);
      final kb = extractSortKey(b);
      if (ka.runtimeType == kb.runtimeType) {
        final cmp = ka.compareTo(kb);
        if (cmp != 0) return cmp;
      }
      return (a['key'] as String).compareTo(b['key'] as String);
    });

    var filtered = sorted;
    final bounds = query['bounds'] as List? ?? const [];
    for (final bRaw in bounds) {
      final b = Map<String, dynamic>.from(bRaw as Map);
      final bKind = b['kind'] as String;
      final bVal = b['value'];
      filtered = filtered.where((e) {
        final k = extractSortKey(e);
        if (bVal is num && k is num) {
          if (bKind == 'equalTo') return k == bVal;
          if (bKind == 'startAt') return k >= bVal;
          if (bKind == 'endAt') return k <= bVal;
        } else if (bVal is String && k is String) {
          if (bKind == 'equalTo') return k == bVal;
          if (bKind == 'startAt') return k.compareTo(bVal) >= 0;
          if (bKind == 'endAt') return k.compareTo(bVal) <= 0;
        }
        return true;
      }).toList();
    }

    final limitMap = query['limit'] is Map
        ? Map<String, dynamic>.from(query['limit'] as Map)
        : null;
    if (limitMap != null) {
      final lKind = limitMap['kind'] as String;
      final n = limitMap['n'] as int;
      if (lKind == 'limitToFirst' && filtered.length > n) {
        filtered = filtered.sublist(0, n);
      } else if (lKind == 'limitToLast' && filtered.length > n) {
        filtered = filtered.sublist(filtered.length - n);
      }
    }

    return filtered;
  }
}
