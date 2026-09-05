import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';

import '../auth/mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricDebugController controller;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);

    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    harness.ackAttach(clientSessionId: 'sess-ui-1');
    await connectFuture;

    controller = PyricDebugController(
      authPlatform: auth,
      bridgeClient: client,
    );
  });

  tearDown(() async {
    controller.dispose();
    await auth.dispose();
    await client.disconnect();
    await harness.dispose();
  });

  group('PyricDebugOverlay Widget Tests', () {
    testWidgets('renders floating pill and updates on identity transition and denials', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PyricDebugOverlay(
              controller: controller,
              child: const Center(child: Text('Main App Content')),
            ),
          ),
        ),
      );

      // Verify app content and initial pill
      expect(find.text('Main App Content'), findsOneWidget);
      expect(find.text('ANONYMOUS'), findsOneWidget);
      expect(find.byIcon(Icons.person_off), findsOneWidget);

      // Toggle Admin Bypass
      controller.toggleAdminBypass(true);
      await tester.pumpAndSettle();

      expect(find.text('ADMIN'), findsOneWidget);
      expect(find.byIcon(Icons.shield), findsOneWidget);

      // Add a CEL denial report
      final report = RulesDenialReport(
        citation: 'firestore.rules:14:7',
        expression: 'allow read: if request.auth != null;',
        reasons: ['request.auth is null'],
        requestMethod: 'get',
        requestPath: 'databases/(default)/documents/users/u1',
      );
      controller.addDenial(report);
      await tester.pumpAndSettle();

      // Denial badge counter shows '1'
      expect(find.text('1'), findsOneWidget);

      // Tap floating pill to open PyricDebugSheet
      await tester.tap(find.text('ADMIN'));
      await tester.pumpAndSettle();

      // Verify bottom sheet modal opened
      expect(find.text('Pyric Companion'), findsOneWidget);
      expect(find.text('Identity & Impersonation'), findsOneWidget);
      expect(find.text('Admin Bypass'), findsOneWidget);

      // Switch to Rules Denials tab
      await tester.tap(find.text('Rules Denials'));
      await tester.pumpAndSettle();

      // Verify CEL denial card is rendered
      expect(find.text('PERMISSION_DENIED'), findsOneWidget);
      expect(find.text('firestore.rules:14:7'), findsOneWidget);
      expect(find.text('allow read: if request.auth != null;'), findsOneWidget);
      expect(find.text('1-Tap Admin Bypass'), findsOneWidget);
    });
  });
}
