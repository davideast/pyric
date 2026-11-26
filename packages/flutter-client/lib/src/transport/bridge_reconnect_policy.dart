import 'dart:async';
import 'dart:math' as math;

import 'package:web_socket_channel/web_socket_channel.dart';

/// Factory signature for injecting mock or custom WebSocket channels (e.g. in tests).
typedef WebSocketChannelFactory = FutureOr<WebSocketChannel> Function(
  Uri uri,
  Map<String, dynamic> headers,
);

/// Sends one worker operation on the connection being restored.
typedef BridgeRestoreOperation = Future<dynamic> Function(
  String method,
  Map<String, dynamic> params,
);

/// Re-establishes the session's Auth user on a replaced bridge host.
typedef BridgeAuthRestorer = Future<void> Function(BridgeRestoreOperation op);

/// The bridge client's transport state.
///
/// `interrupted` covers every reconnect attempt after a drop. `closed` is
/// terminal: the client was disconnected or hit a failure that permits no retry.
enum BridgeConnectionState { connecting, attached, interrupted, closed }

/// Delivered on a subscription registered with `includeMetadataChanges` when
/// the connection drops after it has delivered a value. The listener reports
/// its last snapshot again with `fromCache` set.
class BridgeSubscriptionGap {
  const BridgeSubscriptionGap._();

  static const BridgeSubscriptionGap instance = BridgeSubscriptionGap._();
}

const String bridgeConnectionLostMessage =
    'The bridge connection was lost. Requests already sent may have completed; check state before retrying.';
const String bridgeHoldExpiredMessage =
    'The bridge connection was not restored within 10 seconds. The request was not sent.';
const String bridgeAuthRestoreFailedMessage =
    'The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent.';
const Duration bridgeDefaultHoldDeadline = Duration(seconds: 10);
// ADR-0019, heartbeat amendment: a ping at attach and every 15 seconds, and a
// socket that delivers no frame for 45 seconds (three heartbeats) is a drop.
const Duration bridgeDefaultHeartbeatInterval = Duration(seconds: 15);
const Duration bridgeDefaultLivenessTimeout = Duration(seconds: 45);
const int bridgePolicyCloseCode = 1008;
const int _maxReconnectDelayMs = 5000;
final math.Random _jitterSource = math.Random();

/// The wait before reconnect attempt [attempt] (0-based): 250 ms doubling to a
/// 5 s cap, plus up to 250 ms of jitter, never above 5 s.
Duration bridgeReconnectDelay(int attempt, [math.Random? random]) {
  final exponent = math.min(attempt, 10);
  final base = math.min(_maxReconnectDelayMs, 250 * (1 << exponent));
  final jitter =
      (random ?? _jitterSource).nextDouble() * math.min(250, base / 10);
  return Duration(
    milliseconds: math.min(_maxReconnectDelayMs, base + jitter).floor(),
  );
}
