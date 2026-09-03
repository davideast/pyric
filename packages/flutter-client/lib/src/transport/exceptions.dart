/// Exception thrown on Pyric bridge RPC rejections, timeouts, or connection failures.
class PyricBridgeException implements Exception {
  final String code;
  final String message;
  final dynamic denialContext;
  final dynamic envelope;

  const PyricBridgeException({
    required this.code,
    required this.message,
    this.denialContext,
    this.envelope,
  });

  @override
  String toString() {
    if (denialContext != null) {
      return 'PyricBridgeException($code): $message [denialContext: $denialContext]';
    }
    return 'PyricBridgeException($code): $message';
  }
}
