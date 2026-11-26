import 'dart:async';

/// Per-socket heartbeat and liveness monitor (ADR-0019, heartbeat amendment).
///
/// Sends an immediate ping on attach and repeats at [interval], treating a
/// socket with no inbound frames for [livenessTimeout] as dropped before
/// pinging.
class BridgeHeartbeat {
  final Duration Function() interval;
  final Duration Function() livenessTimeout;
  final bool Function(int generation) isCurrentGeneration;
  final void Function(String pingId) sendPing;
  final void Function(int generation, String reason) onSilentDrop;

  Timer? _timer;
  final Stopwatch _sinceLastFrame = Stopwatch();
  int _pingCounter = 0;

  BridgeHeartbeat({
    required this.interval,
    required this.livenessTimeout,
    required this.isCurrentGeneration,
    required this.sendPing,
    required this.onSilentDrop,
  });

  void start(int generation) {
    stop();
    _sinceLastFrame
      ..reset()
      ..start();
    // The ping at attach starts the host's watch of this socket.
    sendPing('hb-${++_pingCounter}');
    _schedule(generation);
  }

  void recordInboundFrame() {
    _sinceLastFrame.reset();
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _sinceLastFrame.stop();
  }

  // Waits one interval, or less when the liveness timeout falls sooner, so a
  // silent socket is noticed after the liveness timeout as on the web client.
  // Dart offers no clock that keeps running while the device sleeps, so
  // [_sinceLastFrame] is monotonic and pauses then.
  void _schedule(int generation) {
    final currentInterval = interval();
    final currentTimeout = livenessTimeout();
    final remainingLiveness = currentTimeout - _sinceLastFrame.elapsed;
    final delay =
        remainingLiveness < currentInterval ? remainingLiveness : currentInterval;
    // A negative delay fires at once.
    _timer = Timer(delay, () {
      _timer = null;
      if (!isCurrentGeneration(generation)) return;
      // Checked before the send, so a client resumed after a suspension
      // reconnects instead of pinging a socket the host has already closed.
      if (_sinceLastFrame.elapsed >= currentTimeout) {
        onSilentDrop(
          generation,
          'The Pyric bridge sent nothing for ${currentTimeout.inMilliseconds}ms.',
        );
        return;
      }
      sendPing('hb-${++_pingCounter}');
      _schedule(generation);
    });
  }
}
