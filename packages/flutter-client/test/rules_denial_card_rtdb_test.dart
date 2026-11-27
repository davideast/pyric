import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart'
    hide AuthLens, PyricAuthCredentialsProvider;

import 'auth/mock_bridge_helper.dart';

void main() {
  testWidgets(
      'RulesDenialCard renders RTDB matchedPath, bindings, scalar and list proposedValue, and RTDB labels',
      (tester) async {
    setupMockFirebase();
    final harness = MockBridgeHarness();
    final client = harness.createClient();
    final auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    final controller = PyricDebugController(
      authPlatform: auth,
      bridgeClient: client,
    );
    addTearDown(() async {
      controller.dispose();
      await auth.dispose();
      await client.disconnect();
    });

    final report = RulesDenialReport(
      engine: 'rtdb',
      file: 'database.rules.json',
      matchedPath: '/rooms/\$roomId/count',
      matchedRule: 'auth.uid == \$roomId',
      pathVariableBindings: const {'\$roomId': 'bob'},
      requestMethod: 'set',
      requestPath: '/rooms/bob/count',
      authUid: 'alice',
      proposedValue: 42,
      existingData: const {'prev': 1},
      reasons: const ['write rule evaluated to false'],
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: RulesDenialCard(
              report: report,
              controller: controller,
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('View Evaluation Context'));
    await tester.pumpAndSettle();

    expect(find.text('/rooms/\$roomId/count'), findsOneWidget);
    expect(find.text('\$roomId: bob'), findsOneWidget);
    expect(find.text('Proposed Value (newData)'), findsOneWidget);
    expect(find.text('42'), findsOneWidget);
    expect(find.text('Existing Data (data)'), findsOneWidget);

    final listReport = RulesDenialReport(
      engine: 'rtdb',
      file: 'database.rules.json',
      matchedPath: '/rooms/\$roomId/tags',
      requestMethod: 'set',
      requestPath: '/rooms/bob/tags',
      proposedValue: const ['alpha', 'beta'],
      reasons: const ['validate rule failed'],
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: RulesDenialCard(
              key: const ValueKey('list-card'),
              report: listReport,
              controller: controller,
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('View Evaluation Context'));
    await tester.pumpAndSettle();

    expect(find.text('Proposed Value (newData)'), findsOneWidget);
    expect(find.textContaining('"alpha"'), findsOneWidget);
    expect(find.textContaining('"beta"'), findsOneWidget);
  });
}
