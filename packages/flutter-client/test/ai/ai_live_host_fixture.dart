import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

const FirebaseOptions defaultLiveAiOptions = FirebaseOptions(
  apiKey: 'demo-flutter-live-api-key',
  appId: '1:424242424242:android:flutterailive',
  messagingSenderId: '424242424242',
  projectId: 'demo-flutter-live',
);

class LiveAiFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? defaultLiveAiOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, defaultLiveAiOptions),
    );
  }
}

class ForgedAppCheckPlatform extends FirebaseAppCheckPlatform {
  final String? tokenValue;

  ForgedAppCheckPlatform(this.tokenValue);

  @override
  Future<String?> getToken(bool forceRefresh) async => tokenValue;

  @override
  Future<String> getLimitedUseToken() async => tokenValue ?? '';
}

Uri? resolveLiveAiBridgeUri() {
  final liveRaw = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (liveRaw.isNotEmpty) {
    return Uri.parse(liveRaw);
  }
  final fallbackRaw = Platform.environment['PYRIC_BRIDGE_URL']?.trim() ?? '';
  if (fallbackRaw.isNotEmpty) {
    return Uri.parse(fallbackRaw);
  }
  return null;
}

String resolveLiveAiProjectId() {
  final raw = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ?? '';
  if (raw.isNotEmpty) {
    return raw;
  }
  return 'demo-flutter-live';
}

Map<String, dynamic> scriptedAiEngineWire() {
  return <String, dynamic>{
    'kind': 'scripted',
    'script': <Map<String, dynamic>>[
      <String, dynamic>{
        'match': 'FLUTTER_AI_JSON_RECIPE',
        'respond': <String, dynamic>{
          'json': <String, dynamic>{'dish': 'Matcha Pancakes', 'servings': 2},
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_THOUGHT_AND_TOOL',
        'respond': <String, dynamic>{
          'modelVersion': 'gemini-2.5-flash',
          'responseId': 'resp-live-tool-1',
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'STOP',
              'content': <String, dynamic>{
                'role': 'model',
                'parts': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'text': 'Need current weather for Kyoto.',
                    'thought': true,
                    'thoughtSignature': 'sig-live-thought-1',
                  },
                  <String, dynamic>{
                    'functionCall': <String, dynamic>{
                      'name': 'getCurrentWeather',
                      'args': <String, dynamic>{'city': 'Kyoto', 'unit': 'celsius'},
                      'id': 'call-kyoto-1',
                    },
                    'thoughtSignature': 'sig-live-fn-1',
                  },
                ],
              },
            },
          ],
          'usageMetadata': <String, dynamic>{
            'promptTokenCount': 12,
            'candidatesTokenCount': 9,
            'thoughtsTokenCount': 6,
            'totalTokenCount': 27,
          },
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_SAFETY_BLOCK',
        'respond': <String, dynamic>{
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'SAFETY',
              'finishMessage': 'Candidate blocked by safety filter.',
              'safetyRatings': <Map<String, dynamic>>[
                <String, dynamic>{
                  'category': 'HARM_CATEGORY_DANGEROUS_CONTENT',
                  'probability': 'HIGH',
                  'blocked': true,
                },
              ],
            },
          ],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_RECITATION_BLOCK',
        'respond': <String, dynamic>{
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'RECITATION',
              'finishMessage': 'Candidate blocked due to recitation.',
            },
          ],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_QUOTA_ERR',
        'respond': <String, dynamic>{
          'error': <String, dynamic>{
            'code': 429,
            'message': 'Quota exhausted for model gemini-2.5-flash.',
            'status': 'RESOURCE_EXHAUSTED',
          },
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_STREAM_CHUNKS',
        'respond': <String, dynamic>{
          'chunks': <String>['Stream ', 'chunk ', 'complete!'],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_STREAM_CANCEL',
        'respond': <String, dynamic>{
          'chunks': <String>['Alpha ', 'Beta ', 'Gamma'],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_CHAT_TOOL_START',
        'respond': <String, dynamic>{
          'functionCall': <String, dynamic>{
            'name': 'lookupStock',
            'args': <String, dynamic>{'ticker': 'GOOG'},
          },
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_CHAT_STREAM_TURN',
        'respond': <String, dynamic>{
          'chunks': <String>['GOOG trades ', 'at 198.25 USD.'],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_CHAT_SAFETY_TURN',
        'respond': <String, dynamic>{
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'SAFETY',
              'finishMessage': 'Chat turn blocked.',
            },
          ],
        },
      },
    ],
  };
}

Future<({FirebaseApp app, PyricBridgeClient client})> connectLiveAiApp(
  Uri bridgeUri,
  String suffix,
) async {
  final projectId = resolveLiveAiProjectId();
  final liveApp = await Firebase.initializeApp(
    name: 'flutter-ai-$suffix-${DateTime.now().microsecondsSinceEpoch}',
    options: FirebaseOptions(
      apiKey: 'demo-flutter-live-api-key',
      appId: '1:424242424242:android:flutterailive',
      messagingSenderId: '424242424242',
      projectId: projectId,
    ),
  );
  final client = PyricBridgeClient(
    uri: bridgeUri,
    headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
  );
  await client.connect();
  return (app: liveApp, client: client);
}
