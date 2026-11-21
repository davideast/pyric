import Foundation
import Testing
import FirebaseAuth
import PyricAppCheck
import PyricFirestore
import PyricFunctions

private struct LiveCallableEchoInput: Codable, Sendable {
    let sku: String
    let count: Int
}

private struct LiveCallableEchoEnvelope: Codable, Sendable {
    let dataType: String
    let data: EchoedPayload

    struct EchoedPayload: Codable, Sendable, Equatable {
        let sku: String
        let count: Int
    }
}

private struct LiveStreamInput: Codable, Sendable {
    let chunks: [String]
}

private struct LiveStreamResultPayload: Codable, Sendable, Equatable {
    let acceptsStreaming: Bool
    let sendChunkResults: [Bool]
}

@Suite("PyricFunctions Live-Host Conformance Suite", .serialized)
struct PyricFunctionsLiveHostTests {
    private static func trimmedEnv(_ key: String) -> String? {
        guard let raw = ProcessInfo.processInfo.environment[key]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    @Test("Executes v2, v1, URL, Codable, regional Int64, structured HttpsError, deadlines, Auth + App Check, and SSE streaming over live Functions HTTP gateway")
    func fullLiveHostFunctionsWorkflow() async throws {
        guard let rawFunctionsURL = Self.trimmedEnv("PYRIC_LIVE_FUNCTIONS_URL"),
              let rawBridgeURL = Self.trimmedEnv("PYRIC_LIVE_BRIDGE_URL") else {
            // Offline mode (e.g. standalone `swift test` without external Node gateway):
            // verify hermetic off-machine guard on an isolated FirebaseApp.
            let offlineName = "offline-swift-fn-\(UUID().uuidString)"
            let offlineOpts = FirebaseOptions(projectID: "demo-offline-swift-fn")
            let offlineApp = FirebaseApp(name: offlineName, options: offlineOpts, environment: [:])
            let offlineFunctions = Functions.functions(app: offlineApp)
            do {
                _ = try await offlineFunctions
                    .httpsCallable(URL(string: "https://api.example.com/offMachine")!)
                    .call(nil)
                Issue.record("Expected unavailable error for off-machine URL")
            } catch {
                let ns = error as NSError
                #expect(ns.domain == FunctionsErrorDomain)
                #expect(ns.code == FunctionsErrorCode.unavailable.rawValue)
            }
            await offlineApp.delete()
            return
        }

        let projectID = Self.trimmedEnv("PYRIC_LIVE_PROJECT_ID") ?? "demo-swift-functions-live"
        let iosAppID = Self.trimmedEnv("PYRIC_LIVE_IOS_APP_ID") ?? "1:424242424242:ios:swiftfunctionsclient"
        let functionsURI = try #require(URL(string: rawFunctionsURL))
        let bridgeURI = try #require(URL(string: rawBridgeURL))
        let bridgeHost = try #require(bridgeURI.host)
        let bridgePort = try #require(bridgeURI.port)
        let gatewayHost = try #require(functionsURI.host)
        let gatewayPort = try #require(functionsURI.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let previousFactory = AppCheck.providerFactory
            defer {
                AppCheck.setAppCheckProviderFactory(previousFactory)
            }

            let options = FirebaseOptions(
                projectID: projectID,
                apiKey: "sandbox-functions-key",
                googleAppID: iosAppID
            )
            let appName = "live-swift-functions-\(UUID().uuidString)"
            FirebaseApp.configure(name: appName, options: options)
            let app = try #require(FirebaseApp.app(name: appName))
            app.useEmulator(withHost: bridgeHost, port: bridgePort)

            let functions = Functions.functions(app: app)

            // 1. Off-machine origin is refused before any network I/O
            do {
                _ = try await functions
                    .httpsCallable(URL(string: "https://api.example.com/offMachine")!)
                    .call(nil)
                Issue.record("Expected FunctionsErrorCode.unavailable for off-machine URL")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .unavailable)
            }

            // 2. Unauthenticated v2 echo, v1 echo, cloudfunctions.net URL rewrite, Codable Callable, and regional Int64Value
            let v2Res = try await functions.httpsCallable("pyricCallableEcho").call([
                "sku": "widget-42",
                "tags": ["fast", 2, true, NSNull()] as [Any]
            ])
            let v2Map = try #require(v2Res.data as? [String: Any])
            #expect((v2Map["dataType"] as? String) == "object")
            let echoedData = try #require(v2Map["data"] as? [String: Any])
            #expect((echoedData["sku"] as? String) == "widget-42")
            let authBefore = try #require(v2Map["auth"] as? [String: Any])
            let appBefore = try #require(v2Map["app"] as? [String: Any])
            #expect((authBefore["present"] as? Bool) == false)
            #expect((appBefore["present"] as? Bool) == false)

            let v1Res = try await functions.httpsCallable("pyricCallableV1").call(["v1": "ok"])
            let v1Map = try #require(v1Res.data as? [String: Any])
            let v1Echoed = try #require(v1Map["data"] as? [String: Any])
            #expect((v1Echoed["v1"] as? String) == "ok")

            let cfURL = try #require(
                URL(string: "https://us-central1-\(projectID).cloudfunctions.net/pyricCallableEcho")
            )
            let fromURLRes = try await functions.httpsCallable(cfURL).call(["via": "cloudfunctions"])
            let fromURLMap = try #require(fromURLRes.data as? [String: Any])
            let fromURLEchoed = try #require(fromURLMap["data"] as? [String: Any])
            #expect((fromURLEchoed["via"] as? String) == "cloudfunctions")

            let typedEcho: Callable<LiveCallableEchoInput, LiveCallableEchoEnvelope> =
                functions.httpsCallable("pyricCallableEcho")
            let typedOut = try await typedEcho(LiveCallableEchoInput(sku: "codable-9", count: 7))
            #expect(typedOut.dataType == "object")
            #expect(typedOut.data == .init(sku: "codable-9", count: 7))

            let regionalFunctions = Functions.functions(app: app, region: "europe-west1")
            regionalFunctions.useEmulator(withHost: gatewayHost, port: gatewayPort)
            let bigIntInput = 9_007_199_254_740_993
            let regionalRes = try await regionalFunctions.httpsCallable("regionalInt64Echo").call([
                "bigInput": bigIntInput
            ])
            let regionalMap = try #require(regionalRes.data as? [String: Any])
            #expect((regionalMap["region"] as? String) == "europe-west1")
            #expect((regionalMap["receivedInput"] as? Int) == bigIntInput)
            #expect((regionalMap["int64"] as? Int) == bigIntInput)

            // 3. Structured HttpsError details, unhandled INTERNAL throw, NOT_FOUND, and client deadline-exceeded
            do {
                _ = try await functions.httpsCallable("pyricCallableEcho").call([
                    "mode": "throw",
                    "code": "invalid-argument",
                    "message": "sku must match pattern",
                    "details": ["field": "sku", "code": 1004] as [String: Any]
                ])
                Issue.record("Expected invalidArgument HttpsError")
            } catch {
                let ns = error as NSError
                #expect(ns.domain == FunctionsErrorDomain)
                #expect(ns.code == FunctionsErrorCode.invalidArgument.rawValue)
                #expect(ns.localizedDescription == "sku must match pattern")
                let details = try #require(ns.userInfo[FunctionsErrorDetailsKey] as? [String: Any])
                #expect((details["field"] as? String) == "sku")
                #expect((details["code"] as? Int) == 1004)
            }

            do {
                _ = try await functions.httpsCallable("pyricCallableEcho").call(["mode": "throw-plain"])
                Issue.record("Expected internal error on plain throw")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .internal)
            }

            do {
                _ = try await functions.httpsCallable("nonExistentFunctionName").call(nil)
                Issue.record("Expected notFound error")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .notFound)
            }

            let shortDeadlineCallable = functions.httpsCallable("pyricCallableEcho")
            shortDeadlineCallable.timeoutInterval = 0.05
            do {
                _ = try await shortDeadlineCallable.call(["mode": "delay", "ms": 400])
                Issue.record("Expected deadlineExceeded error")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .deadlineExceeded)
            }

            // 4. Enforced App Check fails before provider registration, then succeeds with Auth + standard & limited-use App Check tokens
            do {
                _ = try await functions.httpsCallable("pyricCallableEnforced").call(["step": "before-appcheck"])
                Issue.record("Expected unauthenticated error when App Check is uninitialized")
            } catch let fnErr as FunctionsError {
                #expect(fnErr.code == .unauthenticated)
            }

            let auth = Auth.auth(app: app)
            let authResult = try await auth.createUser(
                withEmail: "swift-functions-caller@example.test",
                password: "correct-horse-battery-staple"
            )
            #expect(!authResult.user.uid.isEmpty)

            AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
            let appCheck = try #require(AppCheck.appCheck(app: app))
            AppCheck.setAppCheckProviderFactory(previousFactory)
            let mintedStd = try await appCheck.token(forcingRefresh: false)
            #expect(!mintedStd.token.isEmpty)

            let enforcedRes = try await functions.httpsCallable("pyricCallableEnforced").call([
                "step": "with-tokens"
            ])
            let enforcedMap = try #require(enforcedRes.data as? [String: Any])
            let authReport = try #require(enforcedMap["auth"] as? [String: Any])
            let appReport = try #require(enforcedMap["app"] as? [String: Any])
            #expect((authReport["present"] as? Bool) == true)
            #expect((authReport["uidMatchesSub"] as? Bool) == true)
            #expect((authReport["aud"] as? String) == projectID)
            #expect((appReport["present"] as? Bool) == true)
            #expect((appReport["appIdPresent"] as? Bool) == true)

            let limitedOpts = HTTPSCallableOptions(requireLimitedUseAppCheckTokens: true)
            let consumeFirst = try await functions
                .httpsCallable("pyricCallableConsume", options: limitedOpts)
                .call(["seq": 1])
            let firstApp = try #require((consumeFirst.data as? [String: Any])?["app"] as? [String: Any])
            #expect((firstApp["present"] as? Bool) == true)
            #expect((firstApp["alreadyConsumed"] as? Bool) == false)

            let consumeSecond = try await functions
                .httpsCallable("pyricCallableConsume", options: limitedOpts)
                .call(["seq": 2])
            let secondApp = try #require((consumeSecond.data as? [String: Any])?["app"] as? [String: Any])
            #expect((secondApp["alreadyConsumed"] as? Bool) == false)

            // 5. Real URLSession SSE streaming: untyped chunks + terminal result, typed StreamResponse, and mid-stream HttpsError
            var untypedChunks: [Any] = []
            var untypedFinal: [String: Any]?
            for try await event in functions.httpsCallable("pyricCallableStream").stream([
                "chunks": ["alpha", ["idx": 2], "omega"] as [Any]
            ]) {
                switch event {
                case .message(let chunk):
                    untypedChunks.append(chunk)
                case .result(let finalRes):
                    untypedFinal = finalRes.data as? [String: Any]
                }
            }
            #expect(untypedChunks.count == 3)
            #expect((untypedChunks[0] as? String) == "alpha")
            #expect(((untypedChunks[1] as? [String: Any])?["idx"] as? Int) == 2)
            #expect((untypedChunks[2] as? String) == "omega")
            #expect((untypedFinal?["acceptsStreaming"] as? Bool) == true)
            #expect((untypedFinal?["sendChunkResults"] as? [Bool]) == [true, true, true])

            let typedStream: Callable<LiveStreamInput, StreamResponse<String, LiveStreamResultPayload>> =
                functions.httpsCallable("pyricCallableStream")
            var typedEvents: [StreamResponse<String, LiveStreamResultPayload>] = []
            for try await item in try typedStream.stream(LiveStreamInput(chunks: ["one", "two"])) {
                typedEvents.append(item)
            }
            #expect(typedEvents == [
                .message("one"),
                .message("two"),
                .result(LiveStreamResultPayload(acceptsStreaming: true, sendChunkResults: [true, true]))
            ])

            var chunksBeforeThrow: [String] = []
            var caughtMidStreamError: FunctionsError?
            do {
                for try await event in functions.httpsCallable("pyricCallableStream").stream([
                    "chunks": ["only-first", "never-sent"],
                    "mode": "throw"
                ] as [String: Any]) {
                    if case .message(let chunk) = event, let text = chunk as? String {
                        chunksBeforeThrow.append(text)
                    }
                }
            } catch let fnErr as FunctionsError {
                caughtMidStreamError = fnErr
            }
            #expect(chunksBeforeThrow == ["only-first"])
            #expect(caughtMidStreamError?.code == .failedPrecondition)
            #expect(caughtMidStreamError?.message == "stream failed after one chunk")
            #expect(((caughtMidStreamError?.details as? [String: Any])?["after"] as? Int) == 1)

            Functions.reset()
            await app.delete()
        }
    }
}
