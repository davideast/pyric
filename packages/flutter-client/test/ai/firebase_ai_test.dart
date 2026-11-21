import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

import '../helpers/fake_bridge.dart';

class _TestFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final resolved = options ??
        const FirebaseOptions(
          apiKey: 'test-api-key',
          appId: '1:100:android:test',
          messagingSenderId: '100',
          projectId: 'demo-ai-unit',
        );
    final created = FirebaseAppPlatform(appName, resolved);
    _apps[appName] = created;
    return created;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) {
      return existing;
    }
    throw FirebaseException(
      plugin: 'core',
      code: 'no-app',
      message: 'No Firebase App $name has been created.',
    );
  }
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient bridgeClient;

  setUp(() async {
    FirebasePlatform.instance = _TestFirebasePlatform();
    fakeBridge = FakeBridge();
    bridgeClient = PyricBridgeClient(channelFactory: fakeBridge.connect);
    await FirebaseAI.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
  });

  tearDown(() async {
    await FirebaseAI.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('FirebaseAI initialization, caching, and model resource normalization', () {
    test('caches googleAI instances per FirebaseApp and isolates distinct apps', () async {
      final defaultApp = await Firebase.initializeApp();
      final secondaryApp = await Firebase.initializeApp(
        name: 'secondary-ai-app',
        options: const FirebaseOptions(
          apiKey: 'test-api-key-2',
          appId: '1:200:ios:test2',
          messagingSenderId: '200',
          projectId: 'demo-ai-unit',
        ),
      );
      FirebaseAI.registerWith(bridgeClient: bridgeClient);

      final implicitDefault = FirebaseAI.googleAI();
      final explicitDefault = FirebaseAI.googleAI(app: defaultApp);
      final secondary = FirebaseAI.googleAI(app: secondaryApp);

      expect(identical(implicitDefault, explicitDefault), isTrue);
      expect(identical(implicitDefault, secondary), isFalse);
      expect(implicitDefault.app?.name, equals(defaultApp.name));
      expect(secondary.app?.name, equals('secondary-ai-app'));
      expect(implicitDefault.backendType, equals(FirebaseAIBackendType.googleAI));
      expect(implicitDefault.location, isEmpty);
    });

    test('isolates vertexAI instances by location and limited-use token flag', () async {
      final app = await Firebase.initializeApp();
      FirebaseAI.registerWith(bridgeClient: bridgeClient);

      final defaultUsCentral = FirebaseAI.vertexAI(app: app);
      final explicitUsCentral = FirebaseAI.vertexAI(
        app: app,
        location: 'us-central1',
      );
      final blankLocationFallback = FirebaseAI.vertexAI(
        app: app,
        location: '   ',
      );
      final europeWest = FirebaseAI.vertexAI(
        app: app,
        location: 'europe-west4',
      );
      final limitedUse = FirebaseAI.vertexAI(
        app: app,
        location: 'us-central1',
        useLimitedUseAppCheckTokens: true,
      );

      expect(identical(defaultUsCentral, explicitUsCentral), isTrue);
      expect(identical(defaultUsCentral, blankLocationFallback), isTrue);
      expect(identical(defaultUsCentral, europeWest), isFalse);
      expect(identical(defaultUsCentral, limitedUse), isFalse);
      expect(defaultUsCentral.location, equals('us-central1'));
      expect(europeWest.location, equals('europe-west4'));
      expect(limitedUse.useLimitedUseAppCheckTokens, isTrue);
    });

    test('clearInstancesForTest evicts cached instances without closing injected bridge', () async {
      await Firebase.initializeApp();
      await bridgeClient.connect();
      FirebaseAI.registerWith(bridgeClient: bridgeClient);

      final first = FirebaseAI.googleAI();
      await FirebaseAI.clearInstancesForTest();
      expect(bridgeClient.isDisposed, isFalse);

      FirebaseAI.registerWith(bridgeClient: bridgeClient);
      final second = FirebaseAI.googleAI();
      expect(identical(first, second), isFalse);
    });

    test('normalizes Google AI and Vertex AI model resource paths without double-prefixing', () async {
      await Firebase.initializeApp();
      FirebaseAI.registerWith(bridgeClient: bridgeClient);

      final google = FirebaseAI.googleAI();
      final vertex = FirebaseAI.vertexAI(location: 'us-east4');

      expect(
        google.generativeModel(model: 'gemini-2.5-flash').model,
        equals('models/gemini-2.5-flash'),
      );
      expect(
        google.generativeModel(model: 'models/gemini-2.5-pro').model,
        equals('models/gemini-2.5-pro'),
      );
      expect(
        vertex.generativeModel(model: 'gemini-2.5-flash').model,
        equals('publishers/google/models/gemini-2.5-flash'),
      );
      expect(
        vertex.generativeModel(model: 'models/gemini-2.5-flash').model,
        equals('publishers/google/models/gemini-2.5-flash'),
      );
      expect(
        vertex
            .generativeModel(model: 'publishers/acme/models/custom-1')
            .model,
        equals('publishers/acme/models/custom-1'),
      );
    });

    test('rejects blank model names synchronously with no-model FirebaseAIException', () {
      final ai = FirebaseAI.googleAI(bridgeClient: bridgeClient);
      expect(
        () => ai.generativeModel(model: '   '),
        throwsA(
          isA<FirebaseAIException>().having(
            (err) => err.code,
            'code',
            equals('no-model'),
          ),
        ),
      );
    });

    test('validates useAIEmulator host and port boundaries', () async {
      final ai = FirebaseAI.googleAI(bridgeClient: bridgeClient);

      await expectLater(
        ai.useAIEmulator('', 5174),
        throwsA(
          isA<FirebaseAIException>().having(
            (err) => err.code,
            'code',
            equals('invalid-argument'),
          ),
        ),
      );
      await expectLater(
        ai.useAIEmulator('127.0.0.1', 0),
        throwsA(
          isA<FirebaseAIException>().having(
            (err) => err.code,
            'code',
            equals('invalid-argument'),
          ),
        ),
      );
      await expectLater(
        ai.useAIEmulator('127.0.0.1', 70000),
        throwsA(
          isA<FirebaseAIException>().having(
            (err) => err.code,
            'code',
            equals('invalid-argument'),
          ),
        ),
      );
    });
  });
}
