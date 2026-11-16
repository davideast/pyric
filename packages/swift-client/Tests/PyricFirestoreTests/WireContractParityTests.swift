import Foundation
import Testing
@testable import PyricFirestore

@Suite("Firestore Wire Contract Parity Suite")
struct WireContractParityTests {

    @Test("Attach frame advertises firestore value encoding capability and decodes legacy frames")
    func testAttachCapabilities() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        let attachFrame = try await mock.awaitNextSentMessage()

        #expect(attachFrame["type"]?.stringValue == "attach")
        #expect(attachFrame["protocol"]?.intValue == 1)
        let rawCaps = try #require(attachFrame["capabilities"]?.arrayValue)
        let caps = rawCaps.compactMap(\.stringValue)
        #expect(caps.contains(ValueCodec.docValueEncodingV1))

        try mock.simulateServerMessage(["type": "attach-ack", "protocol": 1, "peerConnected": true])
        try await connectTask.value
        await client.disconnect()

        let legacyData = Data("{\"type\":\"attach\",\"protocol\":1}".utf8)
        let decodedLegacy = try JSONDecoder().decode(AttachFrame.self, from: legacyData)
        #expect(decodedLegacy.type == "attach")
        #expect(decodedLegacy.protocolVersion == 1)
        #expect(decodedLegacy.capabilities.isEmpty)
    }

    @Test("decodeDocData unwraps pyric/map/1.0 and decodes non-finite number markers when negotiated")
    func testDecodeDocDataWithValueEncoding() throws {
        let wireJson = """
        {
          "type": "pyric/map/1.0",
          "fields": {
            "type": "order",
            "label": "a",
            "count": 2,
            "nav": {
              "type": "pyric/map/1.0",
              "fields": {
                "id": "home",
                "path": "/home"
              }
            },
            "nums": {
              "nan": { "__type": "number", "value": "NaN" },
              "inf": { "__type": "number", "value": "Infinity" },
              "negInf": { "__type": "number", "value": "-Infinity" },
              "negZero": { "__type": "number", "value": "-0" }
            }
          }
        }
        """
        let envelope: [String: Any] = [
            "json": wireJson,
            "valueEncoding": ValueCodec.docValueEncodingV1
        ]
        let decoded = ValueCodec.decodeDocData(envelope)

        #expect(decoded["type"] as? String == "order")
        #expect(decoded["label"] as? String == "a")
        #expect(decoded["count"] as? Int64 == 2)

        let nav = try #require(decoded["nav"] as? [String: Any])
        #expect(nav["id"] as? String == "home")
        #expect(nav["path"] as? String == "/home")

        let nums = try #require(decoded["nums"] as? [String: Any])
        let nanVal = try #require(nums["nan"] as? Double)
        #expect(nanVal.isNaN)
        #expect(nums["inf"] as? Double == Double.infinity)
        #expect(nums["negInf"] as? Double == -Double.infinity)
        let negZero = try #require(nums["negZero"] as? Double)
        #expect(negZero == 0.0)
        #expect(negZero.sign == .minus)
    }

    @Test("decodeDocData preserves literal pyric/map/1.0 when valueEncoding is absent")
    func testDecodeDocDataLegacyPreservesLiteralMap() throws {
        let envelope: [String: Any] = [
            "json": "{\"type\":\"pyric/map/1.0\",\"fields\":{\"a\":1}}"
        ]
        let decoded = ValueCodec.decodeDocData(envelope)
        #expect(decoded["type"] as? String == "pyric/map/1.0")
        let fields = try #require(decoded["fields"] as? [String: Any])
        #expect(fields["a"] as? Int64 == 1)
    }

    @Test("VectorValue and vector sentinels encode and decode canonical firestore/vectorValue/1.0")
    func testCanonicalVectorEncodingAndDecoding() throws {
        let vec = FieldValue.vector([0.1, 0.2, 0.3])
        let encoded = try #require(ValueCodec.encodeValue(vec) as? [String: Any])
        #expect(encoded["type"] as? String == "firestore/vectorValue/1.0")
        #expect(encoded["vectorValues"] as? [Double] == [0.1, 0.2, 0.3])
        #expect(encoded["__sentinel"] == nil)

        let sentinel = PyricVectorSentinel([1.5, 2.5])
        let sentinelWire = try sentinel.toWireSentinel()
        #expect(sentinelWire["type"] as? String == "firestore/vectorValue/1.0")
        #expect(sentinelWire["vectorValues"] as? [Double] == [1.5, 2.5])
        #expect(sentinelWire["__sentinel"] == nil)

        let legacyInput: [String: Any] = ["__sentinel": "vector", "values": [4.0, 5.0]]
        let transmuted = try #require(ValueCodec.encodeValue(legacyInput) as? [String: Any])
        #expect(transmuted["type"] as? String == "firestore/vectorValue/1.0")
        #expect(transmuted["vectorValues"] as? [Double] == [4.0, 5.0])

        let decoded = try #require(ValueCodec.decodeValue(encoded) as? VectorValue)
        #expect(decoded == VectorValue([0.1, 0.2, 0.3]))

        #expect(throws: PyricFirestoreError.self) {
            _ = try ValueCodec.encodeValue(["__sentinel": "vector", "values": "not-an-array"])
        }
        #expect(throws: PyricFirestoreError.self) {
            _ = try ValueCodec.encodeValue(["__sentinel": "vector", "values": [0.1, Double.nan]])
        }
        #expect(throws: PyricFirestoreError.self) {
            _ = try ValueCodec.encodeValue(["__sentinel": "vector", "values": [Double.infinity]])
        }
        #expect(throws: PyricFirestoreError.self) {
            _ = try ValueCodec.encodeValue(FieldValue.vector([0.1, Double.nan]))
        }
        #expect(throws: PyricFirestoreError.self) {
            _ = try ValueCodec.encodeValue(VectorValue([Double.infinity]))
        }
    }

    @Test("Transaction.getDocument preserves wire envelope and valueEncoding and emits null for missing docs")
    func testTransactionReadEnvelopePreservation() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)
        let firestore = Firestore(bridgeClient: client, app: FirebaseApp(name: "txn-parity-\(UUID().uuidString)"))

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "protocol": 1, "peerConnected": true])
        try await connectTask.value

        let tx = Transaction(firestore: firestore)
        let wireJson = "{\"type\":\"pyric/map/1.0\",\"fields\":{\"type\":\"order\",\"a\":1,\"b\":2}}"

        let readExistingTask = Task {
            try await tx.getDocument(firestore.document("items/doc1"))
        }
        let getExistingFrame = try await mock.awaitNextSentMessage()
        let existingId = try #require(getExistingFrame["id"]?.stringValue)
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": existingId,
            "ok": true,
            "value": [
                "exists": true,
                "path": "items/doc1",
                "data": [
                    "json": wireJson,
                    "valueEncoding": ValueCodec.docValueEncodingV1
                ]
            ]
        ])
        let existingSnap = try await readExistingTask.value
        #expect(existingSnap.exists)
        #expect(existingSnap.data()?["type"] as? String == "order")

        let readMissingTask = Task {
            try await tx.getDocument(firestore.document("items/missing"))
        }
        let getMissingFrame = try await mock.awaitNextSentMessage()
        let missingId = try #require(getMissingFrame["id"]?.stringValue)
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": missingId,
            "ok": true,
            "value": [
                "exists": false,
                "path": "items/missing"
            ]
        ])
        let missingSnap = try await readMissingTask.value
        #expect(!missingSnap.exists)

        #expect(tx.stagedReads.count == 2)
        #expect(tx.stagedReads[0].data?.json == wireJson)
        #expect(tx.stagedReads[0].data?.valueEncoding == ValueCodec.docValueEncodingV1)
        let existingWire = tx.stagedReads[0].toAnySendable()
        #expect(existingWire["data"]?["json"]?.stringValue == wireJson)
        #expect(existingWire["data"]?["valueEncoding"]?.stringValue == ValueCodec.docValueEncodingV1)

        #expect(tx.stagedReads[1].data == nil)
        let missingWire = tx.stagedReads[1].toAnySendable()
        #expect(missingWire["data"]?.isNull == true)

        await client.disconnect()
    }
}
