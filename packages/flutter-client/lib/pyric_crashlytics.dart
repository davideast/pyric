/// Pyric Flutter Firebase Crashlytics (`firebase_crashlytics`) client library.
library;

export 'package:firebase_core/firebase_core.dart'
    show FirebaseApp, FirebaseException;
export 'package:flutter/foundation.dart' show FlutterErrorDetails;

export 'src/crashlytics/crashlytics_types.dart'
    show
        CrashlyticsAppState,
        CrashlyticsBreadcrumb,
        CrashlyticsLogEntry,
        CrashlyticsReport,
        CrashlyticsSimulatedCrashError,
        crashlyticsSdkPlatformFlutter,
        firebaseCrashlyticsPluginName,
        maxCrashlyticsBreadcrumbs,
        maxCrashlyticsCustomKeys,
        maxCrashlyticsReports,
        maxCrashlyticsStringChars;
export 'src/crashlytics/crashlytics_wire_codec.dart'
    show
        extractDartExceptionMetadata,
        formatDartStackTrace,
        mapCrashlyticsBridgeException,
        normalizeCrashlyticsCustomEntry,
        normalizeCrashlyticsCustomKeyBatch,
        truncateCrashlyticsString;
export 'src/crashlytics/firebase_crashlytics.dart'
    show
        FirebaseCrashlytics,
        PyricCrashlytics,
        PyricFirebaseCrashlytics;
export 'src/transport/bridge_client.dart'
    show BridgeConnectionState, PyricBridgeClient, PyricBridgeException;
