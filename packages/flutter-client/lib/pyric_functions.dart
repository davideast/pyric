/// Pyric Flutter Cloud Functions (`onCall`) client library.
library;

export 'src/functions/functions_exceptions.dart'
    show FirebaseFunctionsException, codeForHttpStatus, errorForCallableResponse;
export 'src/functions/functions_http_transport.dart'
    show
        DartIoFunctionsHttpTransport,
        FunctionsHttpResponse,
        FunctionsHttpTransport,
        FunctionsSseStreamResponse;
export 'src/functions/functions_serializer.dart'
    show
        decodeCallableData,
        encodeCallableData,
        int64TypeUrl,
        uint64TypeUrl;
export 'src/functions/functions_url.dart'
    show
        ParsedFunctionsRegionOrDomain,
        ResolvedCallableTarget,
        defaultFunctionsRegion,
        isLoopbackHost,
        normalizeEmulatorOrigin,
        parseRegionOrCustomDomain,
        resolveNamedCallableTarget,
        resolveUrlCallableTarget;
export 'src/functions/https_callable.dart'
    show
        Chunk,
        HttpsCallable,
        HttpsCallableOptions,
        HttpsCallableResult,
        Result,
        StreamResponse,
        defaultCallableTimeout;
export 'src/functions/pyric_firebase_functions.dart'
    show
        FirebaseFunctions,
        FunctionsAppCheckTokenProvider,
        FunctionsAuthTokenProvider,
        PyricFirebaseFunctions,
        PyricFunctions;
