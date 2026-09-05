import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDebugUI

@Suite("Milestone M4 Iteration 2: Challenger 2 Remediation & Multi-Instance Isolation")
struct Challenger2RemediationTests {

    private func createConnectedClient() async throws -> (PyricBridgeClient, MockDebugChannel) {
        let channel = MockDebugChannel()
        let client = PyricBridgeClient(channel: channel)

        let connectTask = Task {
            let frame = try await channel.awaitNextSentMessage()
            #expect(frame["type"]?.stringValue == "attach")
            try channel.simulateServerMessage([
                "type": "attach-ack",
                "protocol": 1,
                "peerConnected": true,
                "bridgeVersion": "0.1.0"
            ])
        }

        try await client.connect()
        _ = try await connectTask.value
        return (client, channel)
    }

    @Test("PyricDebugDiagnostics.reset() cleanly tears down tasks, detaches bridge, and finishes all active streams")
    func testDiagnosticsResetTeardownAndStreamFlushing() async throws {
        let (client, channel) = try await createConnectedClient()
        let diagnostics = PyricDebugDiagnostics(bridgeClient: client)

        // Populate initial denial
        let initialReport = RulesDenialReport(
            citation: "firestore.rules:10:1",
            expression: "allow read: if false;",
            reasons: ["Init denial"],
            errorMessage: "Denied"
        )
        diagnostics.record(denial: initialReport)
        #expect(diagnostics.history.count == 1)

        // Spawn multiple concurrent stream consumers
        final class StreamTracker: @unchecked Sendable {
            private let lock = NSLock()
            private var finishedStreams = 0
            private var receivedReports: [Int: [RulesDenialReport]] = [:]

            func record(streamIndex: Int, report: RulesDenialReport) {
                lock.lock()
                defer { lock.unlock() }
                receivedReports[streamIndex, default: []].append(report)
            }

            func markFinished() {
                lock.lock()
                defer { lock.unlock() }
                finishedStreams += 1
            }

            var finishedCount: Int {
                lock.lock()
                defer { lock.unlock() }
                return finishedStreams
            }

            func countFor(streamIndex: Int) -> Int {
                lock.lock()
                defer { lock.unlock() }
                return receivedReports[streamIndex]?.count ?? 0
            }
        }

        let tracker = StreamTracker()
        let streamCount = 5

        for i in 0..<streamCount {
            let stream = diagnostics.denialStream
            Task {
                for await report in stream {
                    tracker.record(streamIndex: i, report: report)
                }
                tracker.markFinished()
            }
        }

        // Give tasks time to subscribe
        try await Task.sleep(nanoseconds: 20_000_000)

        // Broadcast a denial while streams are active
        let liveReport = RulesDenialReport(
            citation: "firestore.rules:20:1",
            expression: "allow write: if false;",
            reasons: ["Live denial"],
            errorMessage: "Write denied"
        )
        diagnostics.record(denial: liveReport)
        try await Task.sleep(nanoseconds: 30_000_000)

        for i in 0..<streamCount {
            #expect(tracker.countFor(streamIndex: i) == 1)
        }
        #expect(tracker.finishedCount == 0)

        // Execute reset()
        diagnostics.reset()

        // Verify history is cleared immediately
        #expect(diagnostics.history.isEmpty)

        // Wait for all stream loops to finish (flushed / terminated)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(tracker.finishedCount == streamCount)

        // Now simulate a late denial arriving on the previously attached bridgeClient
        let lateOpTask = Task<AnySendable, Error> {
            try await client.op(method: "getDoc", params: ["path": "late/doc"])
        }
        let frame = try await channel.awaitNextSentMessage()
        let reqId = try #require(frame["id"]?.stringValue)
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": reqId,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Late denial after reset",
                "denialContext": [
                    "rule": ["line": 999]
                ]
            ] as [String: Any]
        ])
        _ = try? await lateOpTask.value

        try await Task.sleep(nanoseconds: 30_000_000)

        // Late denial MUST NOT be recorded by the detached/reset diagnostics
        #expect(diagnostics.history.isEmpty)

        // Clean re-attachment works normally
        diagnostics.attach(to: client)
        let newOpTask = Task<AnySendable, Error> {
            try await client.op(method: "getDoc", params: ["path": "new/doc"])
        }
        let newFrame = try await channel.awaitNextSentMessage()
        let newReqId = try #require(newFrame["id"]?.stringValue)
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": newReqId,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Post-reattach denial",
                "denialContext": [
                    "rule": ["line": 55]
                ]
            ] as [String: Any]
        ])
        _ = try? await newOpTask.value
        try await Task.sleep(nanoseconds: 30_000_000)

        #expect(diagnostics.history.count == 1)
        #expect(diagnostics.history.first?.line == 55)

        diagnostics.reset()
        await client.disconnect()
    }

    @Test("PyricDebugDiagnostics handles rapid attach and reset cycles without leakage")
    func testRapidAttachResetCycles() async throws {
        let (client, _) = try await createConnectedClient()
        let diagnostics = PyricDebugDiagnostics()

        for i in 0..<30 {
            diagnostics.attach(to: client)
            diagnostics.record(denial: RulesDenialReport(
                citation: "cycle_\(i):1",
                errorMessage: "Cycle \(i)"
            ))
            #expect(diagnostics.history.count == 1)
            diagnostics.reset()
            #expect(diagnostics.history.isEmpty)
        }

        await client.disconnect()
    }

    @Test("Concurrent multi-instance isolation across 10 distinct PyricBridgeClient instances")
    func testConcurrentMultiInstanceIsolation() async throws {
        let instanceCount = 10
        let opsPerInstance = 5

        final class InstanceBundle: @unchecked Sendable {
            let index: Int
            let client: PyricBridgeClient
            let channel: MockDebugChannel
            let firestore: Firestore
            let diagnostics: PyricDebugDiagnostics
            var listenerRegistration: ListenerRegistration?

            let lock = NSLock()
            var onDenialErrors: [PyricBridgeError] = []
            var denialStreamErrors: [PyricBridgeError] = []
            var listenerErrors: [PyricBridgeError] = []

            init(index: Int, client: PyricBridgeClient, channel: MockDebugChannel) {
                self.index = index
                self.client = client
                self.channel = channel
                self.firestore = Firestore(bridgeClient: client)
                self.diagnostics = PyricDebugDiagnostics(bridgeClient: client)
            }

            func recordOnDenial(_ err: PyricBridgeError) {
                lock.lock()
                defer { lock.unlock() }
                onDenialErrors.append(err)
            }

            func recordDenialStream(_ err: PyricBridgeError) {
                lock.lock()
                defer { lock.unlock() }
                denialStreamErrors.append(err)
            }

            func recordListener(_ err: PyricBridgeError) {
                lock.lock()
                defer { lock.unlock() }
                listenerErrors.append(err)
            }
        }

        var bundles: [InstanceBundle] = []
        for i in 0..<instanceCount {
            let (client, channel) = try await createConnectedClient()
            let bundle = InstanceBundle(index: i, client: client, channel: channel)

            bundle.client.onDenial = { [weak bundle] error in
                bundle?.recordOnDenial(error)
            }

            let denialStream = bundle.client.denialStream
            Task { [weak bundle] in
                for await error in denialStream {
                    bundle?.recordDenialStream(error)
                }
            }

            bundle.listenerRegistration = bundle.firestore.addRulesDenialListener { [weak bundle] error in
                bundle?.recordListener(error)
            }

            bundles.append(bundle)
        }

        // Allow all stream tasks to start
        try await Task.sleep(nanoseconds: 30_000_000)

        // Concurrently dispatch ops across all bundles
        await withTaskGroup(of: Void.self) { group in
            for bundle in bundles {
                group.addTask {
                    for opIdx in 0..<opsPerInstance {
                        let expectedLine = bundle.index * 1000 + opIdx
                        let opTask = Task<AnySendable, Error> {
                            try await bundle.client.op(
                                method: "getDoc",
                                params: ["path": .string("col/inst_\(bundle.index)_op_\(opIdx)")]
                            )
                        }

                        do {
                            let frame = try await bundle.channel.awaitNextSentMessage()
                            let reqId = frame["id"]?.stringValue ?? "rop-unknown"
                            try bundle.channel.simulateServerMessage([
                                "type": "worker-res",
                                "id": reqId,
                                "ok": false,
                                "error": [
                                    "code": "permission-denied",
                                    "message": "Denied for instance \(bundle.index) op \(opIdx)",
                                    "denialContext": [
                                        "rule": [
                                            "file": "instance_\(bundle.index).rules",
                                            "line": expectedLine,
                                            "citation": "instance_\(bundle.index).rules:\(expectedLine)"
                                        ]
                                    ]
                                ] as [String: Any]
                            ])
                            _ = try? await opTask.value
                        } catch {
                            // ignore in task
                        }
                    }
                }
            }
        }

        // Wait for all events to propagate
        try await Task.sleep(nanoseconds: 100_000_000)

        // Strict isolation validation
        for bundle in bundles {
            let expectedCount = opsPerInstance
            let expectedBase = bundle.index * 1000

            // 1. Check onDenial callbacks
            #expect(bundle.onDenialErrors.count == expectedCount)
            for err in bundle.onDenialErrors {
                let line = err.denialContext?["rule"]?["line"]?.intValue ?? -1
                #expect(line >= expectedBase && line < expectedBase + opsPerInstance)
                #expect(err.message.contains("Denied for instance \(bundle.index)"))
            }

            // 2. Check denialStream
            #expect(bundle.denialStreamErrors.count == expectedCount)
            for err in bundle.denialStreamErrors {
                let line = err.denialContext?["rule"]?["line"]?.intValue ?? -1
                #expect(line >= expectedBase && line < expectedBase + opsPerInstance)
            }

            // 3. Check Firestore rules denial listener
            #expect(bundle.listenerErrors.count == expectedCount)
            for err in bundle.listenerErrors {
                let line = err.denialContext?["rule"]?["line"]?.intValue ?? -1
                #expect(line >= expectedBase && line < expectedBase + opsPerInstance)
            }

            // 4. Check PyricDebugDiagnostics attached to this bundle
            #expect(bundle.diagnostics.history.count == expectedCount)
            for report in bundle.diagnostics.history {
                let line = report.line ?? -1
                #expect(line >= expectedBase && line < expectedBase + opsPerInstance)
                #expect(report.file == "instance_\(bundle.index).rules")
            }

            // Teardown
            bundle.listenerRegistration?.remove()
            bundle.diagnostics.reset()
            await bundle.client.disconnect()
        }
    }
}
