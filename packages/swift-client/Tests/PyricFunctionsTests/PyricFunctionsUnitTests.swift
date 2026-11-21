import Foundation
import Testing
import PyricFirestore
@testable import PyricFunctions

private struct TypedEchoRequest: Codable, Sendable, Equatable {
    let sku: String
    let quantity: Int
    let bigOrderId: Int64
}

private struct TypedEchoResponse: Codable, Sendable, Equatable {
    let sku: String
    let confirmedOrderId: Int64
    let active: Bool
}

private struct TypedStreamSummary: Codable, Sendable, Equatable {
    let totalChunks: Int
    let completed: Bool
}

@Suite("PyricFunctions Hermetic Unit Suite", .serialized)
struct PyricFunctionsUnitTests {
    private func makeIsolatedApp(
        projectID: String? = "demo-swift-functions-unit",
        environment: [String: String] = [:]
    ) -> FirebaseApp {
        let name = "swift-fn-unit-\(UUID().uuidString)"
        let options = FirebaseOptions(
            projectID: projectID,
            apiKey: "unit-api-key",
            googleAppID: "1:999999999999:ios:swiftfnunit"
        )
        return FirebaseApp(name: name, options: options, environment: environment)
    }

    @Test("Caches Functions instances by (app, region, customDomain) and normalizes emulator origins")
    func instanceCachingAndEmulatorNormalization() async throws {
        let appName = "swift-fn-cache-\(UUID().uuidString)"
        let options = FirebaseOptions(projectID: "demo-fn-cache")
        FirebaseApp.configure(name: appName, options: options)
        let app = try #require(FirebaseApp.app(name: appName))

        let defaultRegionA = Functions.functions(app: app)
        let defaultRegionB = Functions.functions(app: app, region: "us-central1")
        let europe = Functions.functions(app: app, region: "europe-west1")
        let customA = Functions.functions(app: app, customDomain: "http://127.0.0.1:5005/api/")
        let customB = Functions.functions(app: app, region: "http://127.0.0.1:5005/api")

        #expect(defaultRegionA === defaultRegionB)
        #expect(defaultRegionA !== europe)
        #expect(europe.region == "europe-west1")
        #expect(customA === customB)
        #expect(customA.region == "us-central1")
        #expect(customA.customDomain == "http://127.0.0.1:5005/api")

        #expect(defaultRegionA.emulatorOrigin == nil)
        defaultRegionA.useEmulator(withHost: "10.0.2.2", port: 5001)
        #expect(defaultRegionA.emulatorOrigin == "http://127.0.0.1:5001")

        europe.useEmulator(withHost: "::1", port: 5002)
        #expect(europe.emulatorOrigin == "http://[::1]:5002")

        await app.delete()

        // Recreating a FirebaseApp under the same name must not return the stale instance.
        FirebaseApp.configure(name: appName, options: options)
        let recreatedApp = try #require(FirebaseApp.app(name: appName))
        let freshInstance = Functions.functions(app: recreatedApp)
        #expect(freshInstance !== defaultRegionA)
        #expect(freshInstance.emulatorOrigin == nil)
        await recreatedApp.delete()
    }

    @Test("Routes local, cloudfunctions.net, customDomain, and run.app targets while refusing off-machine URLs before network I/O")
    func hermeticTargetRoutingAndOffMachineGuard() async throws {
        let mock = MockFunctionsHTTPTransport()
        mock.onUnary { req in
            FunctionsHTTPResponse(
                statusCode: 200,
                body: Data(#"{"result":{"routedTo":"\#(req.url.absoluteString)"}}"#.utf8)
            )
        }

        // 1. Unconfigured gateway refuses named and cloudfunctions.net callables without touching HTTP transport
        let offlineApp = makeIsolatedApp(projectID: "demo-routing", environment: [:])
        let offlineFn = Functions(app: offlineApp, httpTransport: mock, environment: [:])
        do {
            _ = try await offlineFn.httpsCallable("unconfigured").call(["a": 1])
            Issue.record("Expected off-machine refusal when no gateway or emulator is configured")
        } catch {
            let ns = error as NSError
            #expect(ns.domain == FunctionsErrorDomain)
            #expect(ns.code == FunctionsErrorCode.unavailable.rawValue)
        }
        #expect(mock.requests.isEmpty)

        // 2. Configured gateway routes named, cloudfunctions.net, and legacy + regional run.app URLs
        let env = ["PYRIC_LIVE_FUNCTIONS_URL": "http://127.0.0.1:5999"]
        let hostedApp = makeIsolatedApp(projectID: "demo-routing", environment: env)
        let fn = Functions(app: hostedApp, region: "us-central1", httpTransport: mock, environment: env)

        _ = try await fn.httpsCallable("helloWorld").call(nil)
        _ = try await fn.httpsCallable(
            URL(string: "https://europe-west1-demo-routing.cloudfunctions.net/euFn")!
        ).call(nil)
        _ = try await fn.httpsCallable(
            URL: URL(string: "https://upper-widget-abc123-uc.a.run.app")!
        ).call(nil)
        _ = try await fn.httpsCallable(
            URL(string: "https://billing-worker-424242.asia-northeast1.run.app")!
        ).call(nil)

        let urls = mock.requests.map(\.url.absoluteString)
        #expect(urls == [
            "http://127.0.0.1:5999/demo-routing/us-central1/helloWorld",
            "http://127.0.0.1:5999/demo-routing/europe-west1/euFn",
            "http://127.0.0.1:5999/demo-routing/us-central1/upper-widget?__pyric_run_service=1",
            "http://127.0.0.1:5999/demo-routing/asia-northeast1/billing-worker?__pyric_run_service=1"
        ])

        // 3. Foreign cloudfunctions.net project and arbitrary external HTTPS origins are refused with zero network I/O
        let countBeforeRefusals = mock.requests.count
        for blocked in [
            "https://us-central1-other-project.cloudfunctions.net/helloWorld",
            "https://api.example.com/v1/callable",
            "https://demo-routing.cloudfunctions.net/nested/extra/segment"
        ] {
            do {
                _ = try await fn.httpsCallable(URL(string: blocked)!).call(nil)
                Issue.record("Expected unavailable error for \(blocked)")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .unavailable)
            }
        }
        #expect(mock.requests.count == countBeforeRefusals)

        // 4. Loopback customDomain Hosting rewrite works; off-machine customDomain is refused
        let customLocal = Functions(
            app: hostedApp,
            customDomain: "http://10.0.2.2:5999/hosting-api",
            httpTransport: mock,
            environment: env
        )
        _ = try await customLocal.httpsCallable("rewrittenFn").call(nil)
        #expect(mock.requests.last?.url.absoluteString == "http://127.0.0.1:5999/hosting-api/rewrittenFn")

        let customRemote = Functions(
            app: hostedApp,
            customDomain: "https://functions.example.org",
            httpTransport: mock,
            environment: env
        )
        do {
            _ = try await customRemote.httpsCallable("blockedFn").call(nil)
            Issue.record("Expected off-machine customDomain refusal")
        } catch let fnErr as FunctionsError {
            #expect(fnErr.code == .unavailable)
        }

        await offlineApp.delete()
        await hostedApp.delete()
    }

    @Test("Encodes and decodes 64-bit Int64Value / UInt64Value envelopes and rejects non-finite floats")
    func serializerRoundTripAndValidation() async throws {
        let serializer = FunctionsSerializer()
        let beyondSafeJS: Int64 = 9_007_199_254_740_993
        let maxUnsigned: UInt64 = 18_446_744_073_709_551_615

        let encoded = try serializer.encode([
            "signed64": beyondSafeJS,
            "unsigned64": maxUnsigned,
            "int32": Int32(42),
            "flag": true,
            "pi": 3.25,
            "text": "pyric",
            "empty": NSNull(),
            "nested": [1, "two", false] as [Any]
        ] as [String: Any]) as? [String: Any]

        let signedDict = try #require(encoded?["signed64"] as? [String: String])
        #expect(signedDict == [
            "@type": "type.googleapis.com/google.protobuf.Int64Value",
            "value": "9007199254740993"
        ])
        let unsignedDict = try #require(encoded?["unsigned64"] as? [String: String])
        #expect(unsignedDict == [
            "@type": "type.googleapis.com/google.protobuf.UInt64Value",
            "value": "18446744073709551615"
        ])
        #expect((encoded?["flag"] as? Bool) == true)
        #expect((encoded?["pi"] as? Double) == 3.25)

        let wireData = try JSONSerialization.data(withJSONObject: ["result": encoded as Any], options: [])
        let wireParsed = try #require(try JSONSerialization.jsonObject(with: wireData) as? [String: Any])
        let decoded = try #require(try serializer.decode(wireParsed["result"]) as? [String: Any])

        #expect((decoded["signed64"] as? Int) == Int(beyondSafeJS))
        #expect((decoded["unsigned64"] as? UInt) == UInt(maxUnsigned))
        #expect((decoded["int32"] as? Int) == 42)
        #expect((decoded["flag"] as? Bool) == true)
        #expect((decoded["pi"] as? Double) == 3.25)
        #expect((decoded["text"] as? String) == "pyric")
        #expect(decoded["empty"] is NSNull)

        // Reject NaN and +-Infinity cleanly as FunctionsErrorCode.invalidArgument without crashing JSONSerialization
        let mock = MockFunctionsHTTPTransport()
        let app = makeIsolatedApp(environment: ["PYRIC_LIVE_FUNCTIONS_URL": "http://127.0.0.1:5999"])
        let fn = Functions(
            app: app,
            httpTransport: mock,
            environment: ["PYRIC_LIVE_FUNCTIONS_URL": "http://127.0.0.1:5999"]
        )
        for nonFinite in [Double.nan, Double.infinity, -Double.infinity] {
            do {
                _ = try await fn.httpsCallable("echo").call(["bad": nonFinite])
                Issue.record("Expected invalidArgument for \(nonFinite)")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .invalidArgument)
            }
        }
        #expect(mock.requests.isEmpty)
        await app.delete()
    }

    @Test("Maps all 17 FunctionsErrorCode statuses, NSError userInfo details, completion handlers, and Codable Callable")
    func errorMappingCompletionAndCodableCallable() async throws {
        #expect(FunctionsErrorCode.allCases.count == 17)

        let mock = MockFunctionsHTTPTransport()
        let env = ["PYRIC_LIVE_FUNCTIONS_URL": "http://127.0.0.1:5999"]
        let app = makeIsolatedApp(projectID: "demo-errors", environment: env)
        let fn = Functions(app: app, httpTransport: mock, environment: env)

        // 1. Structured error with Int64Value inside details bridges cleanly to NSError
        mock.onUnary { _ in
            let body = #"""
            {
              "error": {
                "status": "PERMISSION_DENIED",
                "message": "Missing editor role",
                "details": {
                  "requiredRole": "editor",
                  "orgId": {
                    "@type": "type.googleapis.com/google.protobuf.Int64Value",
                    "value": "9007199254740993"
                  }
                }
              }
            }
            """#
            return FunctionsHTTPResponse(statusCode: 403, body: Data(body.utf8))
        }

        do {
            _ = try await fn.httpsCallable("updateDoc").call(["id": "doc-1"])
            Issue.record("Expected permissionDenied error")
        } catch {
            let nsError = error as NSError
            #expect(nsError.domain == FunctionsErrorDomain)
            #expect(nsError.code == FunctionsErrorCode.permissionDenied.rawValue)
            #expect(nsError.localizedDescription == "Missing editor role")
            let details = try #require(nsError.userInfo[FunctionsErrorDetailsKey] as? [String: Any])
            #expect((details["requiredRole"] as? String) == "editor")
            #expect((details["orgId"] as? Int) == 9_007_199_254_740_993)
        }

        // 2. Unrecognized backend error status falls back to .internal without trusting malformed payload
        mock.onUnary { _ in
            FunctionsHTTPResponse(
                statusCode: 500,
                body: Data(#"{"error":{"status":"NOT_A_REAL_GRPC_CODE","message":"untrusted"}}"#.utf8)
            )
        }
        do {
            _ = try await fn.httpsCallable("brokenStatus").call(nil)
            Issue.record("Expected internal error")
        } catch let fnErr as FunctionsError {
            #expect(fnErr.code == .internal)
        }

        // 3. Generic Codable Callable unary + callAsFunction + completion handler
        mock.onUnary { req in
            #expect(req.timeout == 12.5)
            let dataDict = req.bodyJSON?["data"] as? [String: Any]
            let wrappedId = dataDict?["bigOrderId"] as? [String: String]
            let echoedId = wrappedId?["value"] ?? "0"
            let sku = (dataDict?["sku"] as? String) ?? ""
            let responseBody = #"""
            {
              "result": {
                "sku": "\#(sku)",
                "confirmedOrderId": {
                  "@type": "type.googleapis.com/google.protobuf.Int64Value",
                  "value": "\#(echoedId)"
                },
                "active": true
              }
            }
            """#
            return FunctionsHTTPResponse(statusCode: 200, body: Data(responseBody.utf8))
        }

        let typedCallable: Callable<TypedEchoRequest, TypedEchoResponse> = fn.httpsCallable("confirmOrder")
        typedCallable.timeoutInterval = 12.5
        let reqPayload = TypedEchoRequest(sku: "pro-plan", quantity: 3, bigOrderId: 9_007_199_254_740_995)
        let directRes = try await typedCallable(reqPayload)
        #expect(directRes == TypedEchoResponse(sku: "pro-plan", confirmedOrderId: 9_007_199_254_740_995, active: true))

        let callbackRes: TypedEchoResponse = try await withCheckedThrowingContinuation { continuation in
            typedCallable.call(reqPayload) { result in
                continuation.resume(with: result)
            }
        }
        #expect(callbackRes == directRes)

        await app.delete()
    }

    @Test("Streams split UTF-8 SSE frames, decodes typed StreamResponse + plain chunks, and propagates consumer cancellation")
    func streamingSSEParsingTypedDecodingAndCancellation() async throws {
        let mock = MockFunctionsHTTPTransport()
        let env = ["PYRIC_LIVE_FUNCTIONS_URL": "http://127.0.0.1:5999"]
        let app = makeIsolatedApp(projectID: "demo-stream", environment: env)
        let fn = Functions(app: app, httpTransport: mock, environment: env)

        // Split multi-byte UTF-8 ("cafe\u{0301}" = [0x63, 0x61, 0x66, 0x65, 0xCC, 0x81]) across two TCP chunks!
        let frame1Full = Data(": keepalive heartbeat\n\ndata: {\"message\":\"caf\u{00E9}-1\"}\n".utf8)
        let splitIdx = frame1Full.count - 4
        let part1A = frame1Full.subdata(in: 0..<splitIdx)
        let part1B = frame1Full.subdata(in: splitIdx..<frame1Full.count)
        let frame2 = Data("data: {\"message\":\"step-2\"}\ndata: {\"result\":{\"totalChunks\":2,\"completed\":true}}\n\n".utf8)

        mock.onSSE { req in
            #expect(req.headers["Accept"] == "text/event-stream")
            return .init(directives: [
                .rawChunk(part1A),
                .rawChunk(part1B),
                .rawChunk(frame2)
            ])
        }

        // 1. Typed Callable with StreamResponse<String, TypedStreamSummary>
        let typedWithResult: Callable<[String: String], StreamResponse<String, TypedStreamSummary>> =
            fn.httpsCallable("streamTask")
        var events: [StreamResponse<String, TypedStreamSummary>] = []
        for try await item in try typedWithResult.stream(["topic": "utf8"]) {
            events.append(item)
        }
        #expect(events == [
            .message("caf\u{00E9}-1"),
            .message("step-2"),
            .result(TypedStreamSummary(totalChunks: 2, completed: true))
        ])

        // 2. Typed Callable without StreamResponse yields only message chunks
        let typedMessagesOnly: Callable<[String: String], String> = fn.httpsCallable("streamTask")
        var plainChunks: [String] = []
        for try await msg in try typedMessagesOnly.stream(["topic": "messages-only"]) {
            plainChunks.append(msg)
        }
        #expect(plainChunks == ["caf\u{00E9}-1", "step-2"])

        // 3. Breaking out of AsyncThrowingStream cancels the underlying SSE transport immediately
        mock.onSSE { _ in
            .init(directives: [
                .rawChunk(Data("data: {\"message\":\"first\"}\n".utf8)),
                .delayMilliseconds(5_000),
                .rawChunk(Data("data: {\"message\":\"never\"}\n".utf8))
            ])
        }
        var firstSeen: String?
        for try await event in fn.httpsCallable("cancellableStream").stream(nil) {
            if case .message(let raw) = event {
                firstSeen = raw as? String
                break
            }
        }
        #expect(firstSeen == "first")
        // Allow onTermination closure to fire.
        try await Task.sleep(nanoseconds: 25_000_000)
        #expect(mock.cancelledSSEStreams == 1)

        await app.delete()
    }
}
