import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

void main() {
  group('PyricBridgeClient default Host header', () {
    test('uses default localhost:5174 when uri is omitted', () {
      final client = PyricBridgeClient();
      expect(client.headers, equals({'Host': 'localhost:5174'}));
    });

    test('derives Host header from custom loopback port', () {
      final client = PyricBridgeClient(
        uri: Uri.parse('ws://127.0.0.1:3475/__pyric/sandbox'),
      );
      expect(client.headers, equals({'Host': '127.0.0.1:3475'}));
    });

    test('brackets IPv6 literal host with port', () {
      final client = PyricBridgeClient(
        uri: Uri.parse('ws://[::1]:3473/__pyric/sandbox'),
      );
      expect(client.headers, equals({'Host': '[::1]:3473'}));
    });

    test('omits port when uri carries no explicit port', () {
      final client = PyricBridgeClient(
        uri: Uri.parse('wss://sandbox.example/__pyric/sandbox'),
      );
      expect(client.headers, equals({'Host': 'sandbox.example'}));
    });

    test('preserves caller-supplied headers verbatim', () {
      final client = PyricBridgeClient(
        uri: Uri.parse('ws://127.0.0.1:3475/__pyric/sandbox'),
        headers: const {'Host': 'custom.local:9000', 'X-Test': '1'},
      );
      expect(
        client.headers,
        equals({'Host': 'custom.local:9000', 'X-Test': '1'}),
      );
    });
  });
}
