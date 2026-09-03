import Foundation
import Testing
@testable import PyricFirestore

@Suite("Pyric Value Codecs Adversarial Stress Tests", .serialized)
struct ValueCodecStressTests {

    // ─── 1. Boolean vs Number Disambiguation ───────────────────────────────────

    @Test("Disambiguates NSNumber(value: true/false) from numeric 1 and 0 during encoding")
    func testBooleanVsNumberEncoding() throws {
        // NSNumber boolean
        let nsTrue = NSNumber(value: true)
        let nsFalse = NSNumber(value: false)

        let encNsTrue = try ValueCodec.encodeValue(nsTrue)
        let encNsFalse = try ValueCodec.encodeValue(nsFalse)

        #expect(encNsTrue is Bool, "NSNumber(value: true) must encode as Swift Bool")
        #expect(encNsTrue as? Bool == true)
        #expect(encNsFalse is Bool, "NSNumber(value: false) must encode as Swift Bool")
        #expect(encNsFalse as? Bool == false)

        // Numbers 1 and 0 as NSNumber
        let nsOne = NSNumber(value: 1)
        let nsZero = NSNumber(value: 0)
        let encNsOne = try ValueCodec.encodeValue(nsOne)
        let encNsZero = try ValueCodec.encodeValue(nsZero)

        #expect(CFGetTypeID((encNsOne as CFTypeRef)) != CFBooleanGetTypeID(), "NSNumber(1) must NOT encode as CFBoolean")
        #expect(CFGetTypeID((encNsZero as CFTypeRef)) != CFBooleanGetTypeID(), "NSNumber(0) must NOT encode as CFBoolean")

        // Primitives: Int, Int64, Int32, Double, Float
        let encInt1 = try ValueCodec.encodeValue(Int(1))
        let encInt0 = try ValueCodec.encodeValue(Int(0))
        #expect(encInt1 is Int && (encInt1 as? Int == 1))
        #expect(encInt0 is Int && (encInt0 as? Int == 0))

        let encDbl1 = try ValueCodec.encodeValue(Double(1.0))
        let encDbl0 = try ValueCodec.encodeValue(Double(0.0))
        #expect(encDbl1 is Double && (encDbl1 as? Double == 1.0))
        #expect(encDbl0 is Double && (encDbl0 as? Double == 0.0))

        let encFlt1 = try ValueCodec.encodeValue(Float(1.0))
        #expect(encFlt1 is Double && (encFlt1 as? Double == 1.0))
    }

    @Test("Disambiguates NSNumber boolean from numbers during decoding")
    func testBooleanVsNumberDecoding() throws {
        let decTrue = ValueCodec.decodeValue(NSNumber(value: true))
        let decFalse = ValueCodec.decodeValue(NSNumber(value: false))
        #expect(decTrue as? Bool == true)
        #expect(decFalse as? Bool == false)

        let decOne = ValueCodec.decodeValue(NSNumber(value: 1))
        let decZero = ValueCodec.decodeValue(NSNumber(value: 0))
        #expect(decOne as? Int64 == 1)
        #expect(decZero as? Int64 == 0)
        #expect(!(decOne is Bool), "Decoded number 1 must not be Bool")
        #expect(!(decZero is Bool), "Decoded number 0 must not be Bool")

        let decDblOne = ValueCodec.decodeValue(NSNumber(value: 1.0))
        let decDblZero = ValueCodec.decodeValue(NSNumber(value: 0.0))
        #expect(decDblOne as? Double == 1.0)
        #expect(decDblZero as? Double == 0.0)
        #expect(!(decDblOne is Bool))
        #expect(!(decDblZero is Bool))
    }

    @Test("Heterogeneous equality does not equate booleans with numeric 1 or 0")
    func testBooleanVsNumberHeterogeneousEquality() {
        #expect(!anyValuesEqual(true, 1), "true must not equal Int 1")
        #expect(!anyValuesEqual(false, 0), "false must not equal Int 0")
        #expect(!anyValuesEqual(true, 1.0), "true must not equal Double 1.0")
        #expect(!anyValuesEqual(false, 0.0), "false must not equal Double 0.0")

        #expect(!anyValuesEqual(NSNumber(value: true), 1), "NSNumber(true) must not equal Int 1")
        #expect(!anyValuesEqual(NSNumber(value: false), 0), "NSNumber(false) must not equal Int 0")
        #expect(!anyValuesEqual(NSNumber(value: true), NSNumber(value: 1)), "NSNumber(true) must not equal NSNumber(1)")
        #expect(!anyValuesEqual(NSNumber(value: false), NSNumber(value: 0)), "NSNumber(false) must not equal NSNumber(0)")

        #expect(anyValuesEqual(NSNumber(value: true), true), "NSNumber(true) must equal Bool true")
        #expect(anyValuesEqual(NSNumber(value: false), false), "NSNumber(false) must equal Bool false")
        #expect(anyValuesEqual(NSNumber(value: true), NSNumber(value: true)), "NSNumber(true) must equal NSNumber(true)")
        #expect(anyValuesEqual(NSNumber(value: false), NSNumber(value: false)), "NSNumber(false) must equal NSNumber(false)")
    }

    @Test("Maintains exact type distinctions inside nested collections")
    func testNestedBooleanAndNumberCollections() throws {
        let input: [String: Any] = [
            "bools": [true, false, NSNumber(value: true), NSNumber(value: false)],
            "numbers": [1, 0, 1.0, 0.0, NSNumber(value: 1), NSNumber(value: 0)],
            "mixed": [
                "b1": true,
                "n1": 1,
                "d1": 1.0,
                "b0": false,
                "n0": 0,
                "d0": 0.0
            ]
        ]

        let encoded = try #require(ValueCodec.encodeValue(input) as? [String: Any])
        let decoded = try #require(ValueCodec.decodeValue(encoded) as? [String: Any])

        let decodedBools = try #require(decoded["bools"] as? [Any])
        #expect(decodedBools[0] as? Bool == true)
        #expect(decodedBools[1] as? Bool == false)
        #expect(decodedBools[2] as? Bool == true)
        #expect(decodedBools[3] as? Bool == false)

        let decodedNumbers = try #require(decoded["numbers"] as? [Any])
        #expect(decodedNumbers[0] as? Int64 == 1)
        #expect(decodedNumbers[1] as? Int64 == 0)
        #expect(decodedNumbers[2] as? Double == 1.0)
        #expect(decodedNumbers[3] as? Double == 0.0)

        let mixed = try #require(decoded["mixed"] as? [String: Any])
        #expect(mixed["b1"] as? Bool == true)
        #expect(mixed["n1"] as? Int64 == 1)
        #expect(mixed["d1"] as? Double == 1.0)
        #expect(mixed["b0"] as? Bool == false)
        #expect(mixed["n0"] as? Int64 == 0)
        #expect(mixed["d0"] as? Double == 0.0)
    }

    // ─── 2. RFC 4648 Base64URL Unpadded Data ───────────────────────────────────

    @Test("Encodes and decodes inputs of lengths 0, 1, 2, 3, 4, 5 bytes ensuring strict absence of '='")
    func testBase64UrlLengths0Through5() throws {
        let testCases: [(length: Int, bytes: [UInt8])] = [
            (0, []),
            (1, [0x41]),                                   // 'A' -> std 'QQ==' -> url 'QQ'
            (2, [0x41, 0x42]),                             // 'AB' -> std 'QUI=' -> url 'QUI'
            (3, [0x41, 0x42, 0x43]),                       // 'ABC' -> std 'QUJD' -> url 'QUJD'
            (4, [0x41, 0x42, 0x43, 0x44]),                 // 'ABCD' -> std 'QUJDRA==' -> url 'QUJDRA'
            (5, [0x41, 0x42, 0x43, 0x44, 0x45])            // 'ABCDE' -> std 'QUJDREU=' -> url 'QUJDREU'
        ]

        for tc in testCases {
            let data = Data(tc.bytes)
            let encoded = try #require(ValueCodec.encodeValue(data) as? [String: Any])
            #expect(encoded["__type"] as? String == "bytes")
            let b64 = try #require(encoded["base64"] as? String)

            #expect(!b64.contains("="), "Length \(tc.length) must not contain padding '='")
            #expect(!b64.contains("+"), "Length \(tc.length) must not contain '+'")
            #expect(!b64.contains("/"), "Length \(tc.length) must not contain '/'")

            let decoded = try #require(ValueCodec.decodeValue(encoded) as? Data)
            #expect(decoded == data, "Roundtrip failed for length \(tc.length)")
        }
    }

    @Test("Tests URL-safe character substitution '-' and '_' on adversarial byte patterns")
    func testBase64UrlCharSubstitutions() throws {
        // Pattern producing '+' in standard base64: [0xFB, 0xFF, 0xFE] -> '+/++'
        let plusBytes = Data([0xFB, 0xFF, 0xFE])
        let plusEncoded = Base64Codec.base64UrlEncodeUnpadded(plusBytes)
        #expect(plusEncoded == "-__-", "Must replace '+' with '-' and '/' with '_'")
        #expect(!plusEncoded.contains("+"))
        #expect(!plusEncoded.contains("/"))
        #expect(!plusEncoded.contains("="))
        let plusDecoded = Base64Codec.base64UrlDecodeUnpadded(plusEncoded)
        #expect(plusDecoded == plusBytes)

        // Pattern producing '/' in standard base64: [0xFF, 0xFF, 0xFF] -> '////'
        let slashBytes = Data([0xFF, 0xFF, 0xFF])
        let slashEncoded = Base64Codec.base64UrlEncodeUnpadded(slashBytes)
        #expect(slashEncoded == "____", "Must replace '/' with '_'")
        #expect(!slashEncoded.contains("/"))
        let slashDecoded = Base64Codec.base64UrlDecodeUnpadded(slashEncoded)
        #expect(slashDecoded == slashBytes)

        // Variable sizes across all modulo-4 remainders (lengths 6, 7, 8, 9, 10, 11, 12, 16, 64, 256)
        for len in [6, 7, 8, 9, 10, 11, 12, 16, 64, 256] {
            var raw = [UInt8](repeating: 0, count: len)
            for i in 0..<len {
                raw[i] = UInt8((i * 37 + 19) % 256)
            }
            let data = Data(raw)
            let b64Url = Base64Codec.base64UrlEncodeUnpadded(data)
            #expect(!b64Url.contains("="))
            #expect(!b64Url.contains("+"))
            #expect(!b64Url.contains("/"))
            let recovered = Base64Codec.base64UrlDecodeUnpadded(b64Url)
            #expect(recovered == data, "Roundtrip failed for pseudo-random length \(len)")
        }
    }

    @Test("Handles malformed base64url inputs gracefully without throwing")
    func testBase64UrlMalformedResilience() {
        // Invalid length remainder 1 is mathematically impossible in valid base64
        #expect(Base64Codec.base64UrlDecodeUnpadded("A") == nil)
        #expect(Base64Codec.base64UrlDecodeUnpadded("ABCDE") == nil)

        // Illegal characters
        #expect(Base64Codec.base64UrlDecodeUnpadded("!@#$%^") == nil)
        #expect(Base64Codec.base64UrlDecodeUnpadded("AB CD") == nil)

        // Empty string decodes to empty Data
        #expect(Base64Codec.base64UrlDecodeUnpadded("") == Data())
    }

    // ─── 3. Timestamp Extremes ────────────────────────────────────────────────

    @Test("Tests Timestamp boundary dates: min (-62,135,596,800) and max (253,402,300,799)")
    func testTimestampBoundaryDates() throws {
        let minSeconds: Int64 = -62_135_596_800 // 0001-01-01T00:00:00Z
        let maxSeconds: Int64 = 253_402_300_799 // 9999-12-31T23:59:59Z

        // Min bound with 0 and max nanoseconds
        let tsMin0 = Timestamp(seconds: minSeconds, nanoseconds: 0)
        #expect(tsMin0.seconds == minSeconds)
        #expect(tsMin0.nanoseconds == 0)

        let tsMinMaxNano = Timestamp(seconds: minSeconds, nanoseconds: 999_999_999)
        #expect(tsMinMaxNano.seconds == minSeconds)
        #expect(tsMinMaxNano.nanoseconds == 999_999_999)

        // Max bound with 0 and max nanoseconds
        let tsMax0 = Timestamp(seconds: maxSeconds, nanoseconds: 0)
        #expect(tsMax0.seconds == maxSeconds)
        #expect(tsMax0.nanoseconds == 0)

        let tsMaxMaxNano = Timestamp(seconds: maxSeconds, nanoseconds: 999_999_999)
        #expect(tsMaxMaxNano.seconds == maxSeconds)
        #expect(tsMaxMaxNano.nanoseconds == 999_999_999)

        // Serialization & Deserialization roundtrip
        let encMin = try #require(ValueCodec.encodeValue(tsMinMaxNano) as? [String: Any])
        let decMin = try #require(ValueCodec.decodeValue(encMin) as? Timestamp)
        #expect(decMin == tsMinMaxNano)

        let encMax = try #require(ValueCodec.encodeValue(tsMaxMaxNano) as? [String: Any])
        let decMax = try #require(ValueCodec.decodeValue(encMax) as? Timestamp)
        #expect(decMax == tsMaxMaxNano)

        // Wire bounds guards: out-of-range seconds and nanoseconds return nil safely
        let underflowSec: [String: Any] = ["__type": "timestamp", "seconds": -62_135_596_801, "nanos": 0]
        let overflowSec: [String: Any] = ["__type": "timestamp", "seconds": 253_402_300_800, "nanos": 0]
        let underflowNano: [String: Any] = ["__type": "timestamp", "seconds": 0, "nanos": -1]
        let overflowNano: [String: Any] = ["__type": "timestamp", "seconds": 0, "nanos": 1_000_000_000]

        #expect(ValueCodec.decodeValue(underflowSec) == nil, "Underflow seconds must return nil")
        #expect(ValueCodec.decodeValue(overflowSec) == nil, "Overflow seconds must return nil")
        #expect(ValueCodec.decodeValue(underflowNano) == nil, "Underflow nanos must return nil")
        #expect(ValueCodec.decodeValue(overflowNano) == nil, "Overflow nanos must return nil")

        let compatUnderflow: [String: Any] = ["type": "firestore/timestamp/1.0", "seconds": -62_135_596_801, "nanoseconds": 0]
        let compatOverflowNano: [String: Any] = ["type": "firestore/timestamp/1.0", "seconds": 0, "nanoseconds": 1_000_000_000]
        #expect(ValueCodec.decodeValue(compatUnderflow) == nil)
        #expect(ValueCodec.decodeValue(compatOverflowNano) == nil)
    }

    @Test("Tests negative seconds and nanoseconds bounds for Timestamp")
    func testTimestampNegativeSecondsAndNanos() throws {
        let tsNeg1 = Timestamp(seconds: -1, nanoseconds: 0)
        let tsNeg2 = Timestamp(seconds: -1, nanoseconds: 500_000_000)
        let tsNegDeep = Timestamp(seconds: -100_000, nanoseconds: 123_456_789)

        #expect(tsNeg1.seconds == -1 && tsNeg1.nanoseconds == 0)
        #expect(tsNeg2.seconds == -1 && tsNeg2.nanoseconds == 500_000_000)
        #expect(tsNegDeep.seconds == -100_000 && tsNegDeep.nanoseconds == 123_456_789)

        // Date conversions with negative time interval
        let dateNeg = tsNeg2.dateValue()
        #expect(dateNeg.timeIntervalSince1970 == -0.5)

        let roundtripTs = Timestamp(date: dateNeg)
        #expect(roundtripTs == tsNeg2)

        // Ordering (<)
        #expect(tsNegDeep < tsNeg1)
        #expect(tsNeg1 < tsNeg2)
        #expect(tsNeg2 < Timestamp(seconds: 0, nanoseconds: 0))
    }

    @Test("Tests Timestamp nanosecond rollover during Date conversion")
    func testTimestampNanosecondRollover() {
        // Date near rollover fraction (.9999999999)
        let d = Date(timeIntervalSince1970: 1000.9999999999)
        let ts = Timestamp(date: d)
        #expect(ts.seconds == 1001)
        #expect(ts.nanoseconds == 0)
    }

    // ─── 4. GeoPoint Boundary Values ──────────────────────────────────────────

    @Test("Tests GeoPoint boundary coordinates (-90, 90, -180, 180)")
    func testGeoPointBoundaryValues() throws {
        let corners: [(lat: Double, lng: Double)] = [
            (-90.0, -180.0),
            (-90.0, 180.0),
            (90.0, -180.0),
            (90.0, 180.0),
            (0.0, 0.0),
            (-90.0, 0.0),
            (90.0, 0.0),
            (0.0, -180.0),
            (0.0, 180.0)
        ]

        for corner in corners {
            let gp = GeoPoint(latitude: corner.lat, longitude: corner.lng)
            #expect(gp.latitude == corner.lat)
            #expect(gp.longitude == corner.lng)

            let encoded = try #require(ValueCodec.encodeValue(gp) as? [String: Any])
            let decoded = try #require(ValueCodec.decodeValue(encoded) as? GeoPoint)
            #expect(decoded == gp)
        }

        // Wire bounds guards: out-of-range or NaN coordinates return nil safely
        let underflowLat: [String: Any] = ["__type": "latlng", "lat": -90.0001, "lng": 0.0]
        let overflowLat: [String: Any] = ["__type": "latlng", "lat": 90.0001, "lng": 0.0]
        let underflowLng: [String: Any] = ["__type": "latlng", "lat": 0.0, "lng": -180.0001]
        let overflowLng: [String: Any] = ["__type": "latlng", "lat": 0.0, "lng": 180.0001]
        let nanLat: [String: Any] = ["__type": "latlng", "lat": Double.nan, "lng": 0.0]
        let nanLng: [String: Any] = ["__type": "latlng", "lat": 0.0, "lng": Double.nan]

        #expect(ValueCodec.decodeValue(underflowLat) == nil)
        #expect(ValueCodec.decodeValue(overflowLat) == nil)
        #expect(ValueCodec.decodeValue(underflowLng) == nil)
        #expect(ValueCodec.decodeValue(overflowLng) == nil)
        #expect(ValueCodec.decodeValue(nanLat) == nil)
        #expect(ValueCodec.decodeValue(nanLng) == nil)

        let compatOverflowLat: [String: Any] = ["type": "firestore/geoPoint/1.0", "latitude": 90.1, "longitude": 0.0]
        let compatNanLng: [String: Any] = ["type": "firestore/geoPoint/1.0", "latitude": 0.0, "longitude": Double.nan]
        #expect(ValueCodec.decodeValue(compatOverflowLat) == nil)
        #expect(ValueCodec.decodeValue(compatNanLng) == nil)
    }

    @Test("Tests GeoPoint comparison ordering")
    func testGeoPointOrdering() {
        let gp1 = GeoPoint(latitude: -90.0, longitude: 0.0)
        let gp2 = GeoPoint(latitude: 90.0, longitude: 0.0)
        #expect(gp1 < gp2)

        let gp3 = GeoPoint(latitude: 0.0, longitude: -180.0)
        let gp4 = GeoPoint(latitude: 0.0, longitude: 180.0)
        #expect(gp3 < gp4)

        let gp5 = GeoPoint(latitude: 10.0, longitude: -20.0)
        let gp6 = GeoPoint(latitude: 10.0, longitude: 20.0)
        #expect(gp5 < gp6)
    }

    // ─── 5. FieldValue Sentinels & Transmutation ───────────────────────────────

    @Test("Encodes and transmutates all FieldValue sentinels including vector")
    func testSentinelsAndTransmutation() throws {
        // Direct sentinels
        let st = FieldValue.serverTimestamp()
        let del = FieldValue.delete()
        let incInt = FieldValue.increment(Int64(100))
        let incDbl = FieldValue.increment(-12.5)
        let union = FieldValue.arrayUnion(["apple", 42, false])
        let remove = FieldValue.arrayRemove(["banana", 99])
        let vec = FieldValue.vector([0.1, 0.2, 0.3])

        let encSt = try #require(ValueCodec.encodeValue(st) as? [String: Any])
        #expect(encSt["__sentinel"] as? String == "serverTimestamp")

        let encDel = try #require(ValueCodec.encodeValue(del) as? [String: Any])
        #expect(encDel["__sentinel"] as? String == "deleteField")

        let encIncInt = try #require(ValueCodec.encodeValue(incInt) as? [String: Any])
        #expect(encIncInt["__sentinel"] as? String == "increment")
        #expect((encIncInt["n"] as? NSNumber)?.int64Value == 100)

        let encIncDbl = try #require(ValueCodec.encodeValue(incDbl) as? [String: Any])
        #expect(encIncDbl["__sentinel"] as? String == "increment")
        #expect((encIncDbl["n"] as? NSNumber)?.doubleValue == -12.5)

        let encUnion = try #require(ValueCodec.encodeValue(union) as? [String: Any])
        #expect(encUnion["__sentinel"] as? String == "arrayUnion")
        let unionVals = try #require(encUnion["values"] as? [Any])
        #expect(unionVals.count == 3)

        let encRemove = try #require(ValueCodec.encodeValue(remove) as? [String: Any])
        #expect(encRemove["__sentinel"] as? String == "arrayRemove")

        let encVec = try #require(ValueCodec.encodeValue(vec) as? [String: Any])
        #expect(encVec["__sentinel"] as? String == "vector")
        #expect(encVec["values"] as? [Double] == [0.1, 0.2, 0.3])

        // Transmutations of __type sentinels
        let transSt = try #require(ValueCodec.encodeValue(["__type": "serverTimestamp"]) as? [String: Any])
        #expect(transSt["__sentinel"] as? String == "serverTimestamp")

        let transDel1 = try #require(ValueCodec.encodeValue(["__type": "deleteField"]) as? [String: Any])
        #expect(transDel1["__sentinel"] as? String == "deleteField")

        let transDel2 = try #require(ValueCodec.encodeValue(["__type": "delete"]) as? [String: Any])
        #expect(transDel2["__sentinel"] as? String == "deleteField")

        let transInc1 = try #require(ValueCodec.encodeValue(["__type": "increment", "value": 7]) as? [String: Any])
        #expect(transInc1["__sentinel"] as? String == "increment")
        #expect(transInc1["n"] as? Int == 7)

        let transInc2 = try #require(ValueCodec.encodeValue(["__type": "increment", "n": -15]) as? [String: Any])
        #expect(transInc2["__sentinel"] as? String == "increment")
        #expect(transInc2["n"] as? Int == -15)

        let transUnion = try #require(ValueCodec.encodeValue(["__type": "arrayUnion", "values": ["a", "b"]]) as? [String: Any])
        #expect(transUnion["__sentinel"] as? String == "arrayUnion")
        #expect(transUnion["values"] as? [String] == ["a", "b"])

        let transRemove = try #require(ValueCodec.encodeValue(["__type": "arrayRemove", "values": [1, 2]]) as? [String: Any])
        #expect(transRemove["__sentinel"] as? String == "arrayRemove")
        #expect(transRemove["values"] as? [Int] == [1, 2])
    }

    @Test("Sentinels nested deeply in structures encode properly")
    func testDeeplyNestedSentinels() throws {
        let input: [String: Any] = [
            "level1": [
                "level2": [
                    "timestamp": FieldValue.serverTimestamp(),
                    "counter": FieldValue.increment(Int64(1)),
                    "tags": FieldValue.arrayUnion(["swift", "pyric"])
                ] as [String: Any]
            ] as [String: Any]
        ]

        let encoded = try #require(ValueCodec.encodeValue(input) as? [String: Any])
        let level1 = try #require(encoded["level1"] as? [String: Any])
        let level2 = try #require(level1["level2"] as? [String: Any])

        let st = try #require(level2["timestamp"] as? [String: Any])
        #expect(st["__sentinel"] as? String == "serverTimestamp")

        let inc = try #require(level2["counter"] as? [String: Any])
        #expect(inc["__sentinel"] as? String == "increment")
        #expect((inc["n"] as? NSNumber)?.int64Value == 1)

        let tags = try #require(level2["tags"] as? [String: Any])
        #expect(tags["__sentinel"] as? String == "arrayUnion")
    }

    // ─── 6. Envelope Unwrapping & Robustness ───────────────────────────────────

    @Test("Unwraps { 'json': string } envelope with nested arrays, objects, and NSNull values")
    func testEnvelopeUnwrappingWithComplexValues() throws {
        let jsonStr = """
        {
            "stringField": "hello",
            "nullField": null,
            "nestedArray": [1, [2, 3], null, {"deep": "value"}],
            "dictWithNull": {
                "key1": null,
                "key2": "valid"
            },
            "typedDate": {
                "__type": "timestamp",
                "seconds": 1700000000,
                "nanos": 500000
            }
        }
        """

        let envelope: [String: Any] = ["json": jsonStr]
        let decoded = ValueCodec.decodeDocData(envelope)

        #expect(decoded["stringField"] as? String == "hello")
        #expect(decoded["nullField"] is NSNull, "nullField should be preserved as NSNull")

        let arr = try #require(decoded["nestedArray"] as? [Any])
        #expect(arr.count == 4)
        #expect(arr[0] as? Int64 == 1)
        #expect(arr[2] is NSNull)

        let dictWithNull = try #require(decoded["dictWithNull"] as? [String: Any])
        #expect(dictWithNull["key1"] is NSNull)
        #expect(dictWithNull["key2"] as? String == "valid")

        let ts = try #require(decoded["typedDate"] as? Timestamp)
        #expect(ts.seconds == 1_700_000_000)
        #expect(ts.nanoseconds == 500_000)
    }

    @Test("Gracefully handles invalid JSON, empty strings, and non-dict envelopes in decodeDocData")
    func testEnvelopeMalformedInputs() {
        // Invalid JSON syntax
        #expect(ValueCodec.decodeDocData(["json": "{bad: json}"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "{\"unclosed\": "]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "not_json"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "{"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "}"]).isEmpty)

        // Empty strings
        #expect(ValueCodec.decodeDocData(["json": ""]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "   "]).isEmpty)
        #expect(ValueCodec.decodeDocData("").isEmpty)
        #expect(ValueCodec.decodeDocData("   ").isEmpty)

        // JSON string holding non-dictionary (e.g. array, number, boolean)
        #expect(ValueCodec.decodeDocData(["json": "[1, 2, 3]"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "\"just_string\""]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "12345"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "true"]).isEmpty)
        #expect(ValueCodec.decodeDocData(["json": "null"]).isEmpty)

        // Nil and primitive inputs to decodeDocData
        #expect(ValueCodec.decodeDocData(nil).isEmpty)
        #expect(ValueCodec.decodeDocData(NSNull()).isEmpty)
        #expect(ValueCodec.decodeDocData(123).isEmpty)
        #expect(ValueCodec.decodeDocData(true).isEmpty)
    }
}
