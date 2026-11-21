import Foundation
import Testing
@testable import PyricFirestore

private final class RecordedSpecBox: @unchecked Sendable {
    private let lock = NSLock()
    private var spec: [String: AnySendable] = [:]

    func store(_ next: [String: AnySendable]) {
        lock.lock()
        defer { lock.unlock() }
        spec = next
    }

    func load() -> [String: AnySendable] {
        lock.lock()
        defer { lock.unlock() }
        return spec
    }
}

@Suite("Firestore Upstream Oracle Parity Tests")
struct FirestoreOracleParityTests {

    @Test("AggregateQuerySnapshot preserves Int64 count and sum precision, Double averages, empty NSNull, encodedData special doubles, and literal-dot FieldPath")
    func testAggregateQuerySnapshotParity() async throws {
        let harness = try await AdversarialMockHarness.create()
        defer {
            Task { try? await harness.firestore.terminate() }
        }

        let specBox = RecordedSpecBox()

        let exactBeyondDoublePrecision: Int64 = 9_007_199_254_740_993
        let countField = AggregateField.count()
        let intSumField = AggregateField.sum("intScore")
        let bigSumField = AggregateField.sum("bigScore")
        let fracSumField = AggregateField.sum("fracScore")
        let emptySumField = AggregateField.sum("emptyScore")
        let nanSumField = AggregateField.sum("nanScore")
        let negZeroAvgField = AggregateField.average("negZeroScore")
        let emptyAvgField = AggregateField.average("emptyScore")
        let dottedPathSumField = AggregateField.sum(FieldPath(["amount.v1"]))
        let nestedStringSumField = AggregateField.sum("amount.v1")

        #expect(dottedPathSumField != nestedStringSumField)

        harness.onWorkerOp = { id, method, op in
            if method == "aggregate" {
                specBox.store(op["spec"]?.dictionaryValue ?? [:])

                return [
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": [
                        "data": [
                            countField.alias: Int64(3),
                            intSumField.alias: Int64(90),
                            bigSumField.alias: exactBeyondDoublePrecision,
                            fracSumField.alias: 42.5,
                            emptySumField.alias: Int64(0),
                            nanSumField.alias: NSNull(),
                            negZeroAvgField.alias: 0,
                            emptyAvgField.alias: NSNull(),
                            dottedPathSumField.alias: Int64(77),
                            nestedStringSumField.alias: Int64(11),
                        ] as [String: Any],
                        "encodedData": [
                            nanSumField.alias: ["__type": "number", "value": "NaN"],
                            negZeroAvgField.alias: ["__type": "number", "value": "-0"],
                            emptyAvgField.alias: NSNull(),
                        ] as [String: Any],
                    ] as [String: Any],
                ]
            }
            return nil
        }

        let aggQuery = harness.firestore.collection("scores").aggregate([
            countField,
            intSumField,
            bigSumField,
            fracSumField,
            emptySumField,
            nanSumField,
            negZeroAvgField,
            emptyAvgField,
            dottedPathSumField,
            nestedStringSumField,
        ])
        let snap = try await aggQuery.getAggregation(source: .server)

        #expect(snap.count.int64Value == 3)
        #expect(!NSNumberInspector.isFloatingPoint(snap.count))

        let intSumNum = try #require(snap.get(intSumField) as? NSNumber)
        #expect(intSumNum.int64Value == 90)
        #expect(!NSNumberInspector.isFloatingPoint(intSumNum))

        let bigSumNum = try #require(snap.get(bigSumField) as? NSNumber)
        #expect(bigSumNum.int64Value == exactBeyondDoublePrecision)
        #expect(!NSNumberInspector.isFloatingPoint(bigSumNum))

        let fracSumNum = try #require(snap.get(fracSumField) as? NSNumber)
        #expect(fracSumNum.doubleValue == 42.5)
        #expect(NSNumberInspector.isFloatingPoint(fracSumNum))

        let emptySumNum = try #require(snap.get(emptySumField) as? NSNumber)
        #expect(emptySumNum.int64Value == 0)

        let nanSumNum = try #require(snap.get(nanSumField) as? NSNumber)
        #expect(nanSumNum.doubleValue.isNaN)

        let negZeroAvgNum = try #require(snap.get(negZeroAvgField) as? NSNumber)
        #expect(negZeroAvgNum.doubleValue == 0.0)
        #expect(negZeroAvgNum.doubleValue.sign == .minus)

        #expect(snap.get(emptyAvgField) is NSNull)
        #expect(snap.get(AggregateField.sum("unrequested")) == nil)

        let dottedNum = try #require(snap.get(dottedPathSumField) as? NSNumber)
        let nestedNum = try #require(snap.get(nestedStringSumField) as? NSNumber)
        #expect(dottedNum.int64Value == 77)
        #expect(nestedNum.int64Value == 11)

        let recordedSpec = specBox.load()
        let recordedDottedSpec = recordedSpec[dottedPathSumField.alias]?.dictionaryValue
        let recordedNestedSpec = recordedSpec[nestedStringSumField.alias]?.dictionaryValue

        #expect(recordedDottedSpec?["path"]?.arrayValue == [.string("amount.v1")])
        #expect(recordedNestedSpec?["path"] == nil)
    }

    @Test("ValueCodec and DocumentSnapshot round-trip negative zero, NaN, Infinity, Int64, literal-dot FieldPath, and VectorValue")
    func testNegativeZeroAndSnapshotFieldPathRoundTrip() async throws {
        let harness = try await AdversarialMockHarness.create()
        defer {
            Task { try? await harness.firestore.terminate() }
        }

        let payload: [String: Any] = [
            "negZero": -0.0,
            "posZero": 0.0,
            "posFloat": 1.25,
            "nanVal": Double.nan,
            "infVal": Double.infinity,
            "negInfVal": -Double.infinity,
            "bigInt": Int64(6_000_000_000),
            "meta.v1": "literal-dot",
            "meta": ["v1": "nested-map"],
            "embedding": FieldValue.vector([1.25, -2.5, 3.75]),
        ]

        let encoded = try ValueCodec.encodeWriteData(payload)
        let negZeroMarker = try #require(encoded["negZero"] as? [String: Any])
        #expect(negZeroMarker["__type"] as? String == "number")
        #expect(negZeroMarker["value"] as? String == "-0")
        #expect(encoded["posZero"] as? Double == 0.0)

        let jsonBytes = try JSONSerialization.data(withJSONObject: encoded)
        let jsonString = try #require(String(data: jsonBytes, encoding: .utf8))

        let wireSnap: [String: Any] = [
            "id": "d1",
            "path": "items/d1",
            "exists": true,
            "hasPendingWrites": false,
            "data": [
                "valueEncoding": ValueCodec.docValueEncodingV1,
                "json": jsonString,
            ] as [String: Any],
        ]

        let snap = DocumentSnapshot.fromWire(
            firestore: harness.firestore,
            path: "items/d1",
            wireAny: wireSnap
        )

        let decodedNegZero = try #require(snap.get("negZero") as? Double)
        #expect(decodedNegZero == 0.0)
        #expect(decodedNegZero.sign == .minus)

        let rawPosZero = snap.get("posZero")
        #expect((rawPosZero as? Double == 0.0) || (rawPosZero as? Int64 == 0))
        if let dblPosZero = rawPosZero as? Double {
            #expect(dblPosZero.sign == .plus)
        }
        let decodedPosFloat = try #require(snap.get("posFloat") as? Double)
        #expect(decodedPosFloat == 1.25)

        let decodedNan = try #require(snap.get("nanVal") as? Double)
        #expect(decodedNan.isNaN)
        #expect(snap.get("infVal") as? Double == Double.infinity)
        #expect(snap.get("negInfVal") as? Double == -Double.infinity)
        #expect(snap.get("bigInt") as? Int64 == 6_000_000_000)

        #expect(snap.get("meta.v1") as? String == "nested-map")
        #expect(snap.get(FieldPath(["meta.v1"])) as? String == "literal-dot")

        let vec = try #require(snap.get("embedding") as? VectorValue)
        #expect(vec.array == [1.25, -2.5, 3.75])
    }

    @Test("runTransaction maps exhausted contention retries to failedPrecondition and retries transient contention within maxAttempts")
    func testTransactionContentionExhaustionErrorCode() async throws {
        let harness = try await AdversarialMockHarness.create()
        defer {
            Task { try? await harness.firestore.terminate() }
        }

        let commitCounter = AtomicCounter(0)
        harness.onWorkerOp = { id, method, _ in
            if method == "txnCommit" {
                let n = commitCounter.increment()
                if n == 1 {
                    return [
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": [
                            "code": "aborted",
                            "message": "Document version changed concurrently.",
                        ],
                    ]
                }
                return [
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": NSNull(),
                ]
            }
            if method == "updateDoc" {
                return [
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": [
                        "code": "not-found",
                        "message": "No document to update.",
                    ],
                ]
            }
            return nil
        }

        // maxAttempts = 1 exhausts immediately on conflict -> failedPrecondition (matching Cloud Firestore Commit precondition failure).
        var exhaustedCode: FirestoreErrorCode?
        do {
            _ = try await harness.firestore.runTransaction(options: TransactionOptions(maxAttempts: 1)) { txn in
                txn.setData(["v": 1], forDocument: harness.firestore.document("items/contended"))
                return nil
            }
        } catch let err as PyricBridgeError {
            exhaustedCode = err.code
        }
        #expect(exhaustedCode == .failedPrecondition)

        // Reset counter: attempt 1 aborts, attempt 2 commits under maxAttempts = 3.
        let retryCounter = AtomicCounter(0)
        harness.onWorkerOp = { id, method, _ in
            if method == "txnCommit" {
                if retryCounter.increment() == 1 {
                    return [
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "aborted", "message": "Contention on attempt 1."],
                    ]
                }
                return ["type": "worker-res", "id": id, "ok": true, "value": NSNull()]
            }
            if method == "updateDoc" {
                return [
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": ["code": "not-found", "message": "No document to update."],
                ]
            }
            return nil
        }

        let committedVal = try await harness.firestore.runTransaction(options: TransactionOptions(maxAttempts: 3)) { txn in
            txn.setData(["v": 2], forDocument: harness.firestore.document("items/contended"))
            return 42
        }
        #expect(committedVal as? Int == 42)
        #expect(retryCounter.value == 2)

        // Missing-doc updateData surfaces .notFound.
        var updateMissingCode: FirestoreErrorCode?
        do {
            try await harness.firestore.document("items/missing").updateData(["v": 9])
        } catch let err as PyricBridgeError {
            updateMissingCode = err.code
        }
        #expect(updateMissingCode == .notFound)
    }
}
