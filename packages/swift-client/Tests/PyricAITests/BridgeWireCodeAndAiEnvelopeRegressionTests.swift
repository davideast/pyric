import Foundation
import Testing
@testable import PyricAI
@testable import PyricFirestore

@Suite("Bridge Delivery, Wire-Code & AI Envelope Regression Tests", .serialized)
struct BridgeWireCodeAndAiEnvelopeRegressionTests {

    @Test("PyricBridgeError.fromCode strips database/ and firestore/ prefixes and yields denials without denialContext")
    func prefixedWireCodesNormalizeAndYieldDenials() {
        let rtdb = PyricBridgeError.fromCode(code: "database/permission-denied", message: "denied")
        #expect(rtdb.code == .permissionDenied)
        #expect(PyricBridgeClient.shouldYieldDenial(
            wireCode: "database/permission-denied",
            normalizedCode: rtdb.code,
            denialContext: nil
        ))

        let fs = PyricBridgeError.fromCode(code: "firestore/permission-denied", message: "denied")
        #expect(fs.code == .permissionDenied)
        #expect(PyricBridgeClient.shouldYieldDenial(
            wireCode: "firestore/permission-denied",
            normalizedCode: fs.code,
            denialContext: nil
        ))

        let bare = PyricBridgeError.fromCode(code: "PERMISSION_DENIED", message: "denied")
        #expect(bare.code == .permissionDenied)

        let precond = PyricBridgeError.fromCode(code: "firestore/FAILED_PRECONDITION", message: "missing index")
        #expect(precond.code == .failedPrecondition)
    }

    @Test("AiBridgeSession.decodeWireError decodes both aiEnvelope and envelope fields")
    func decodeWireErrorSupportsBothEnvelopeKeys() {
        let payload: AnySendable = .dictionary([
            "error": .dictionary([
                "code": .int(400),
                "message": .string("API key not valid."),
                "status": .string("INVALID_ARGUMENT"),
                "details": .array([
                    .dictionary([
                        "@type": .string("type.googleapis.com/google.rpc.ErrorInfo"),
                        "reason": .string("API_KEY_INVALID"),
                    ])
                ]),
            ])
        ])

        let fromAi = AiBridgeSession.decodeWireError(.dictionary([
            "code": .string("invalid-argument"),
            "message": .string("fallback"),
            "aiEnvelope": payload,
        ]))
        #expect(fromAi.status == .invalidArgument)
        #expect(fromAi.httpResponseCode == 400)
        #expect(fromAi.details.first?["reason"] == .string("API_KEY_INVALID"))

        let fromPlain = AiBridgeSession.decodeWireError(.dictionary([
            "code": .string("invalid-argument"),
            "message": .string("fallback"),
            "envelope": payload,
        ]))
        #expect(fromPlain.status == .invalidArgument)
        #expect(fromPlain.httpResponseCode == 400)
        #expect(fromPlain.details.first?["reason"] == .string("API_KEY_INVALID"))
    }

    @Test("Injected PyricBridgeClient unary generateContent preserves aiEnvelope into BackendError")
    func injectedBridgeClientPreservesAiEnvelope() async throws {
        let channel = MockAiBridgeChannel()
        channel.enqueueReply(.unaryError(
            code: "invalid-argument",
            message: "API key not valid.",
            aiEnvelope: [
                "error": .object([
                    "code": .number(400),
                    "message": .string("API key not valid."),
                    "status": .string("INVALID_ARGUMENT"),
                    "details": .array([
                        .object([
                            "@type": .string("type.googleapis.com/google.rpc.ErrorInfo"),
                            "reason": .string("API_KEY_INVALID"),
                        ])
                    ]),
                ])
            ]
        ))
        let bridgeClient = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "ai-injected-envelope-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-ai", apiKey: "bad", googleAppID: "1:1:ios:ai")
        )
        let ai = FirebaseAI.firebaseAI(app: app, bridgeClient: bridgeClient)
        let model = ai.generativeModel(modelName: "gemini-2.5-flash")
        do {
            _ = try await model.generateContent("hi")
            Issue.record("Expected GenerateContentError / BackendError")
        } catch let error as GenerateContentError {
            if case .internalError(let underlying) = error,
               let backend = underlying as? BackendError {
                #expect(backend.status == .invalidArgument)
                #expect(backend.httpResponseCode == 400)
                #expect(backend.details.first?["reason"] == .string("API_KEY_INVALID"))
            } else {
                Issue.record("Unexpected GenerateContentError: \(error)")
            }
        } catch let backend as BackendError {
            #expect(backend.status == .invalidArgument)
            #expect(backend.httpResponseCode == 400)
            #expect(backend.details.first?["reason"] == .string("API_KEY_INVALID"))
        }
        await ai.disconnect()
        await bridgeClient.disconnect()
    }

    private final class StateBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: BridgeConnectionState = .connecting

        func set(_ next: BridgeConnectionState) {
            lock.lock()
            value = next
            lock.unlock()
        }

        func get() -> BridgeConnectionState {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    @Test("BridgeLocalStreams notifies synchronous stateObservers before waking AsyncStream continuations")
    func stateObserversRunBeforeStreamContinuations() async {
        let streams = BridgeLocalStreams()
        let box = StateBox()
        let observerId = streams.addStateObserver { state in
            box.set(state)
        }
        defer { streams.removeStateObserver(observerId) }

        let stream = streams.makeConnectionStatesStream()
        let task = Task<BridgeConnectionState, Never> {
            for await state in stream where state == .attached {
                return box.get()
            }
            return .connecting
        }
        await Task.yield()
        streams.setState(.attached)
        let observed = await task.value
        #expect(observed == .attached)

        let closeStream = streams.makeConnectionStatesStream()
        let closeTask = Task<BridgeConnectionState, Never> {
            for await state in closeStream where state == .closed {
                return box.get()
            }
            return .attached
        }
        await Task.yield()
        streams.closeAll(disposed: true)
        let closedObserved = await closeTask.value
        #expect(closedObserved == .closed)
    }
}
