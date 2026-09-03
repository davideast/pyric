import Foundation
import Testing
@testable import PyricFirestore

@Suite("Pyric Value Codecs Suite")
struct CodecTests {

    // ── 1. Primitives ──────────────────────────────────────────────────────────

    @Test("Serializes and deserializes null, boolean, numeric, and string primitives")
    func testPrimitives() throws {
        // nil / null
        let nullEnc = try ValueCodec.encodeValue(nil)
        #expect(nullEnc is NSNull)
        #expect(ValueCodec.decodeValue(nil) == nil)
        #expect(ValueCodec.decodeValue(NSNull()) == nil)

        // Bools
        #expect(try ValueCodec.encodeValue(true) as? Bool == true)
        #expect(ValueCodec.decodeValue(true) as? Bool == true)
        #expect(try ValueCodec.encodeValue(false) as? Bool == false)
        #expect(ValueCodec.decodeValue(false) as? Bool == false)

        // NSNumber boolean disambiguation
        let nsBoolTrue = NSNumber(value: true)
        let nsBoolEnc = try ValueCodec.encodeValue(nsBoolTrue)
        #expect(nsBoolEnc as? Bool == true)

        // Integers
        #expect(try ValueCodec.encodeValue(42) as? Int == 42)
        #expect(ValueCodec.decodeValue(42) as? Int64 == 42)
        #expect(try ValueCodec.encodeValue(0) as? Int == 0)
        #expect(ValueCodec.decodeValue(0) as? Int64 == 0)
        #expect(try ValueCodec.encodeValue(-999) as? Int == -999)
        #expect(ValueCodec.decodeValue(-999) as? Int64 == -999)

        let bigInt: Int64 = 9_223_372_036_854_775_807
        #expect(try ValueCodec.encodeValue(bigInt) as? Int64 == bigInt)

        // Doubles
        #expect(try ValueCodec.encodeValue(3.14159) as? Double == 3.14159)
        #expect(ValueCodec.decodeValue(3.14159) as? Double == 3.14159)
        #expect(try ValueCodec.encodeValue(-0.001) as? Double == -0.001)

        // Strings
        #expect(try ValueCodec.encodeValue("hello world") as? String == "hello world")
        #expect(ValueCodec.decodeValue("hello world") as? String == "hello world")
        #expect(try ValueCodec.encodeValue("") as? String == "")
        #expect(ValueCodec.decodeValue("") as? String == "")
        #expect(try ValueCodec.encodeValue("🔥 Firestore 🚀") as? String == "🔥 Firestore 🚀")
        #expect(ValueCodec.decodeValue("🔥 Firestore 🚀") as? String == "🔥 Firestore 🚀")
    }

    // ── 2. Timestamp & Date ────────────────────────────────────────────────────

    @Test("Serializes and deserializes Timestamp (primary __type marker)")
    func testTimestampPrimaryMarker() throws {
        let ts = Timestamp(seconds: 1_712_000_000, nanoseconds: 543_210)
        let encoded = try #require(ValueCodec.encodeValue(ts) as? [String: Any])

        #expect(encoded["__type"] as? String == "timestamp")
        #expect(encoded["seconds"] as? Int64 == 1_712_000_000)
        #expect(encoded["nanos"] as? Int32 == 543_210)

        let decoded = try #require(ValueCodec.decodeValue(encoded) as? Timestamp)
        #expect(decoded.seconds == 1_712_000_000)
        #expect(decoded.nanoseconds == 543_210)
        #expect(decoded == ts)
    }

    @Test("Serializes Date into Timestamp marker shape and converts bidirectionally")
    func testDateBidirectionalConversion() throws {
        let date = Date(timeIntervalSince1970: 1_712_000_000.123)
        let encoded = try #require(ValueCodec.encodeValue(date) as? [String: Any])

        #expect(encoded["__type"] as? String == "timestamp")
        #expect(encoded["seconds"] as? Int64 == 1_712_000_000)
        let nanos = try #require(encoded["nanos"] as? Int32)
        #expect(abs(Double(nanos) - 123_000_000) < 500)

        let decoded = try #require(ValueCodec.decodeValue(encoded) as? Timestamp)
        let convertedDate = decoded.dateValue()
        #expect(abs(convertedDate.timeIntervalSince1970 - date.timeIntervalSince1970) < 0.0001)

        let exactDate = Date(timeIntervalSince1970: 1_712_000_000.5)
        let exactEncoded = try #require(ValueCodec.encodeValue(exactDate) as? [String: Any])
        #expect(exactEncoded["nanos"] as? Int32 == 500_000_000)
    }

    @Test("Serializes pre-1970 UTC Date without truncation sign-flip")
    func testPre1970DateHandling() throws {
        // 1969-12-31 23:59:59.500 UTC = -0.5 seconds from 1970 epoch
        let pre1970 = Date(timeIntervalSince1970: -0.5)
        let encoded = try #require(ValueCodec.encodeValue(pre1970) as? [String: Any])

        #expect(encoded["__type"] as? String == "timestamp")
        #expect(encoded["seconds"] as? Int64 == -1)
        #expect(encoded["nanos"] as? Int32 == 500_000_000)

        let decoded = try #require(ValueCodec.decodeValue(encoded) as? Timestamp)
        #expect(decoded.seconds == -1)
        #expect(decoded.nanoseconds == 500_000_000)
        #expect(decoded.dateValue().timeIntervalSince1970 == -0.5)

        // Deep past date: 1960-01-01 00:00:00 UTC (-315619200 seconds)
        let deepPast = Date(timeIntervalSince1970: -315_619_200.0)
        let encodedDeep = try #require(ValueCodec.encodeValue(deepPast) as? [String: Any])
        let decodedDeep = try #require(ValueCodec.decodeValue(encodedDeep) as? Timestamp)
        #expect(decodedDeep.dateValue().timeIntervalSince1970 == -315_619_200.0)
    }

    // ── 3. GeoPoint ────────────────────────────────────────────────────────────

    @Test("Serializes and deserializes GeoPoint (primary __type marker)")
    func testGeoPoint() throws {
        let geo = GeoPoint(latitude: 37.7749, longitude: -122.4194)
        let encoded = try #require(ValueCodec.encodeValue(geo) as? [String: Any])

        #expect(encoded["__type"] as? String == "latlng")
        #expect(encoded["lat"] as? Double == 37.7749)
        #expect(encoded["lng"] as? Double == -122.4194)

        let decoded = try #require(ValueCodec.decodeValue(encoded) as? GeoPoint)
        #expect(decoded.latitude == 37.7749)
        #expect(decoded.longitude == -122.4194)
        #expect(decoded == geo)
    }

    @Test("Validates GeoPoint coordinate bounds")
    func testGeoPointBounds() {
        let northPole = GeoPoint(latitude: 90.0, longitude: 0.0)
        #expect(northPole.latitude == 90.0)

        let southPole = GeoPoint(latitude: -90.0, longitude: 0.0)
        #expect(southPole.latitude == -90.0)

        let dateLineWest = GeoPoint(latitude: 0.0, longitude: -180.0)
        #expect(dateLineWest.longitude == -180.0)

        let dateLineEast = GeoPoint(latitude: 0.0, longitude: 180.0)
        #expect(dateLineEast.longitude == 180.0)
    }

    // ── 4. Data & RFC 4648 Base64URL ───────────────────────────────────────────

    @Test("Serializes and deserializes Data using RFC 4648 unpadded base64url")
    func testBase64UrlUnpadded() throws {
        let bytes = Data([0x00, 0x01, 0x02, 0xFA, 0xFF, 0x0A, 0x14])
        let encoded = try #require(ValueCodec.encodeValue(bytes) as? [String: Any])

        #expect(encoded["__type"] as? String == "bytes")
        let base64Str = try #require(encoded["base64"] as? String)

        // Strict unpadded checks
        #expect(!base64Str.contains("="), "Wire base64url must NOT contain padding '='")
        #expect(!base64Str.contains("+"), "Wire base64url must use '-' instead of '+'")
        #expect(!base64Str.contains("/"), "Wire base64url must use '_' instead of '/'")

        let decoded = try #require(ValueCodec.decodeValue(encoded) as? Data)
        #expect(decoded == bytes)
    }

    @Test("Verifies base64url padding boundary conditions (0, 1, 2, 3 byte lengths)")
    func testBase64UrlPaddingBoundaries() throws {
        // 0 bytes
        let d0 = Data()
        let enc0 = try #require(ValueCodec.encodeValue(d0) as? [String: Any])
        #expect(enc0["base64"] as? String == "")
        #expect(ValueCodec.decodeValue(enc0) as? Data == d0)

        // 1 byte (Standard base64 would pad with '==')
        let d1 = Data([0x61]) // 'a'
        let enc1 = try #require(ValueCodec.encodeValue(d1) as? [String: Any])
        let str1 = try #require(enc1["base64"] as? String)
        #expect(!str1.contains("="))
        #expect(ValueCodec.decodeValue(enc1) as? Data == d1)

        // 2 bytes (Standard base64 would pad with '=')
        let d2 = Data([0x61, 0x62]) // 'ab'
        let enc2 = try #require(ValueCodec.encodeValue(d2) as? [String: Any])
        let str2 = try #require(enc2["base64"] as? String)
        #expect(!str2.contains("="))
        #expect(ValueCodec.decodeValue(enc2) as? Data == d2)

        // 3 bytes (Standard base64 needs no padding)
        let d3 = Data([0x61, 0x62, 0x63]) // 'abc'
        let enc3 = try #require(ValueCodec.encodeValue(d3) as? [String: Any])
        let str3 = try #require(enc3["base64"] as? String)
        #expect(!str3.contains("="))
        #expect(ValueCodec.decodeValue(enc3) as? Data == d3)
    }

    // ── 5. DocumentReference & Resolver ────────────────────────────────────────

    @Test("Serializes and deserializes DocumentReferenceHolder and supports resolver hook")
    func testDocumentReference() throws {
        let holder = DocumentReferenceHolder(path: "users/alovelace")
        let encoded = try #require(ValueCodec.encodeValue(holder) as? [String: Any])

        #expect(encoded["__type"] as? String == "reference")
        #expect(encoded["path"] as? String == "users/alovelace")

        // 1. Without resolver: yields DocumentReferenceHolder
        let decodedDefault = try #require(ValueCodec.decodeValue(encoded) as? DocumentReferenceHolder)
        #expect(decodedDefault.path == "users/alovelace")

        // 2. With custom resolver hook
        let resolved = ValueCodec.decodeValue(encoded, referenceResolver: { path in
            "MockRef(\(path))"
        })
        #expect(resolved as? String == "MockRef(users/alovelace)")
    }

    // ── 6. FieldValue Sentinels ────────────────────────────────────────────────

    @Test("Encodes all FieldValue sentinels to canonical __sentinel format")
    func testFieldValueSentinels() throws {
        // serverTimestamp
        let st = FieldValue.serverTimestamp()
        let encSt = try #require(ValueCodec.encodeValue(st) as? [String: Any])
        #expect(encSt["__sentinel"] as? String == "serverTimestamp")

        // delete
        let del = FieldValue.delete()
        let encDel = try #require(ValueCodec.encodeValue(del) as? [String: Any])
        #expect(encDel["__sentinel"] as? String == "deleteField")

        // increment (Int64)
        let incInt = FieldValue.increment(Int64(42))
        let encIncInt = try #require(ValueCodec.encodeValue(incInt) as? [String: Any])
        #expect(encIncInt["__sentinel"] as? String == "increment")
        #expect((encIncInt["n"] as? NSNumber)?.int64Value == 42)

        // increment (Double)
        let incDbl = FieldValue.increment(-3.5)
        let encIncDbl = try #require(ValueCodec.encodeValue(incDbl) as? [String: Any])
        #expect(encIncDbl["__sentinel"] as? String == "increment")
        #expect((encIncDbl["n"] as? NSNumber)?.doubleValue == -3.5)

        // arrayUnion with nested typed values
        let ts = Timestamp(seconds: 1_700_000_000, nanoseconds: 0)
        let union = FieldValue.arrayUnion(["item1", ts, 99])
        let encUnion = try #require(ValueCodec.encodeValue(union) as? [String: Any])
        #expect(encUnion["__sentinel"] as? String == "arrayUnion")
        let unionValues = try #require(encUnion["values"] as? [Any])
        #expect(unionValues.count == 3)
        #expect(unionValues[0] as? String == "item1")
        let innerTs = try #require(unionValues[1] as? [String: Any])
        #expect(innerTs["__type"] as? String == "timestamp")
        #expect(innerTs["seconds"] as? Int64 == 1_700_000_000)
        #expect(unionValues[2] as? Int == 99)

        // arrayRemove
        let remove = FieldValue.arrayRemove(["oldItem", 123])
        let encRemove = try #require(ValueCodec.encodeValue(remove) as? [String: Any])
        #expect(encRemove["__sentinel"] as? String == "arrayRemove")
        let removeValues = try #require(encRemove["values"] as? [Any])
        #expect(removeValues.count == 2)
        #expect(removeValues[0] as? String == "oldItem")
        #expect(removeValues[1] as? Int == 123)

        // vector
        let vec = FieldValue.vector([1.0, 2.0, 3.5])
        let encVec = try #require(ValueCodec.encodeValue(vec) as? [String: Any])
        #expect(encVec["__sentinel"] as? String == "vector")
        #expect(encVec["values"] as? [Double] == [1.0, 2.0, 3.5])
    }

    @Test("Tests FieldValue sentinel equality and deep comparison")
    func testFieldValueEquality() {
        let st1 = FieldValue.serverTimestamp()
        let st2 = FieldValue.serverTimestamp()
        #expect(st1 == st2)

        let del1 = FieldValue.delete()
        let del2 = FieldValue.delete()
        #expect(del1 == del2)
        #expect(del1 != st1)

        let inc1 = FieldValue.increment(5.0)
        let inc2 = FieldValue.increment(Int64(5))
        #expect(inc1 == inc2)

        let union1 = FieldValue.arrayUnion(["a", 1, true])
        let union2 = FieldValue.arrayUnion(["a", 1, true])
        let union3 = FieldValue.arrayUnion(["a", 2, true])
        #expect(union1 == union2)
        #expect(union1 != union3)

        let remove1 = FieldValue.arrayRemove([10, "x"])
        let remove2 = FieldValue.arrayRemove([10, "x"])
        #expect(remove1 == remove2)
    }

    @Test("Transmutes incoming __type sentinel representations to __sentinel wire shape")
    func testSentinelTransmutation() throws {
        // __type: serverTimestamp
        let transSt = try #require(ValueCodec.encodeValue(["__type": "serverTimestamp"]) as? [String: Any])
        #expect(transSt["__sentinel"] as? String == "serverTimestamp")

        // __type: delete / deleteField
        let transDel1 = try #require(ValueCodec.encodeValue(["__type": "deleteField"]) as? [String: Any])
        #expect(transDel1["__sentinel"] as? String == "deleteField")
        let transDel2 = try #require(ValueCodec.encodeValue(["__type": "delete"]) as? [String: Any])
        #expect(transDel2["__sentinel"] as? String == "deleteField")

        // __type: increment
        let transInc1 = try #require(ValueCodec.encodeValue(["__type": "increment", "value": 10]) as? [String: Any])
        #expect(transInc1["__sentinel"] as? String == "increment")
        #expect(transInc1["n"] as? Int == 10)
        let transInc2 = try #require(ValueCodec.encodeValue(["__type": "increment", "n": 25]) as? [String: Any])
        #expect(transInc2["__sentinel"] as? String == "increment")
        #expect(transInc2["n"] as? Int == 25)

        // __type: arrayUnion
        let transUnion = try #require(ValueCodec.encodeValue(["__type": "arrayUnion", "values": ["x", "y"]]) as? [String: Any])
        #expect(transUnion["__sentinel"] as? String == "arrayUnion")
        #expect(transUnion["values"] as? [String] == ["x", "y"])

        // __type: arrayRemove
        let transRemove = try #require(ValueCodec.encodeValue(["__type": "arrayRemove", "values": ["z"]]) as? [String: Any])
        #expect(transRemove["__sentinel"] as? String == "arrayRemove")
        #expect(transRemove["values"] as? [String] == ["z"])
    }

    // ── 7. Complex Nested Structures ───────────────────────────────────────────

    @Test("Recursively encodes and decodes complex nested collections")
    func testComplexNestedStructures() throws {
        let input: [String: Any] = [
            "string": "value",
            "number": 123,
            "nested": [
                "innerList": [1, 2, "three", true, NSNull()] as [Any],
                "innerMap": ["a": 1, "b": false] as [String: Any]
            ] as [String: Any],
            "list": [
                ["key": "item1"],
                ["key": "item2"]
            ]
        ]

        let encoded = try #require(ValueCodec.encodeValue(input) as? [String: Any])
        let decoded = try #require(ValueCodec.decodeValue(encoded) as? [String: Any])

        #expect(decoded["string"] as? String == "value")
        #expect(decoded["number"] as? Int64 == 123)

        let nested = try #require(decoded["nested"] as? [String: Any])
        let innerList = try #require(nested["innerList"] as? [Any])
        #expect(innerList.count == 5)
        #expect(innerList[0] as? Int64 == 1)
        #expect(innerList[2] as? String == "three")
        #expect(innerList[3] as? Bool == true)
    }

    // ── 8. Document Data Envelope & Malformed Resilience ───────────────────────

    @Test("Decodes full document envelope with nested JSON string and typed markers")
    func testDocumentEnvelopeUnwrapping() throws {
        let jsonPayload = """
        {
            "name": "Ada Lovelace",
            "age": 36,
            "active": true,
            "createdAt": {
                "__type": "timestamp",
                "seconds": 1712000000,
                "nanos": 250000
            },
            "location": {
                "__type": "latlng",
                "lat": 51.5074,
                "lng": -0.1278
            },
            "avatar": {
                "__type": "bytes",
                "base64": "AQIDBA"
            },
            "mentor": {
                "__type": "reference",
                "path": "users/charles_babbage"
            },
            "stats": {
                "scores": [100, 95, 88],
                "lastLogin": {
                    "type": "firestore/timestamp/1.0",
                    "seconds": 1712100000,
                    "nanoseconds": 0
                }
            }
        }
        """

        let envelope: [String: Any] = ["json": jsonPayload]
        let data = ValueCodec.decodeDocData(envelope)

        #expect(data["name"] as? String == "Ada Lovelace")
        #expect(data["age"] as? Int64 == 36)
        #expect(data["active"] as? Bool == true)

        let createdAt = try #require(data["createdAt"] as? Timestamp)
        #expect(createdAt.seconds == 1_712_000_000)
        #expect(createdAt.nanoseconds == 250_000)

        let location = try #require(data["location"] as? GeoPoint)
        #expect(location.latitude == 51.5074)
        #expect(location.longitude == -0.1278)

        let avatar = try #require(data["avatar"] as? Data)
        #expect(avatar == Data([1, 2, 3, 4]))

        let mentor = try #require(data["mentor"] as? DocumentReferenceHolder)
        #expect(mentor.path == "users/charles_babbage")

        let stats = try #require(data["stats"] as? [String: Any])
        #expect(stats["scores"] as? [Int64] == [100, 95, 88])
        let lastLogin = try #require(stats["lastLogin"] as? Timestamp)
        #expect(lastLogin.seconds == 1_712_100_000)
    }

    @Test("Gracefully handles empty, missing, or malformed JSON envelopes without throwing")
    func testMalformedEnvelopeResilience() {
        // Missing or nil inputs
        #expect(ValueCodec.decodeDocData(nil).isEmpty)
        #expect(ValueCodec.decodeDocData([:] as [String: Any]).isEmpty)
        #expect(ValueCodec.decodeDocData("invalid json string").isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "{}"]).isEmpty)

        // Malformed JSON strings
        #expect(ValueCodec.decodeDocData(["json": "{invalid_json}"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "{\"unclosed\": "]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "not even json"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": ""]).isEmpty)
    }

    // ── 9. Compatibility Markers ───────────────────────────────────────────────

    @Test("Deserializes legacy compatibility markers (firestore/timestamp/1.0, etc.)")
    func testCompatibilityMarkers() throws {
        // Timestamp compat marker
        let wireTs: [String: Any] = [
            "type": "firestore/timestamp/1.0",
            "seconds": 1_600_000_000,
            "nanoseconds": 999
        ]
        let decodedTs = try #require(ValueCodec.decodeValue(wireTs) as? Timestamp)
        #expect(decodedTs.seconds == 1_600_000_000)
        #expect(decodedTs.nanoseconds == 999)

        // GeoPoint compat marker
        let wireGeo: [String: Any] = [
            "type": "firestore/geoPoint/1.0",
            "latitude": -33.8688,
            "longitude": 151.2093
        ]
        let decodedGeo = try #require(ValueCodec.decodeValue(wireGeo) as? GeoPoint)
        #expect(decodedGeo.latitude == -33.8688)
        #expect(decodedGeo.longitude == 151.2093)

        // Bytes compat marker (standard base64)
        let rawBytes = Data([10, 20, 30, 40, 50])
        let wireBytes: [String: Any] = [
            "type": "firestore/bytes/1.0",
            "bytes": rawBytes.base64EncodedString()
        ]
        let decodedBytes = try #require(ValueCodec.decodeValue(wireBytes) as? Data)
        #expect(decodedBytes == rawBytes)
    }
}
