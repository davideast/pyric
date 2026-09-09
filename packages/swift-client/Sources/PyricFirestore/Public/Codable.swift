import Foundation

extension CodingUserInfoKey {
    public static let pyricDocumentReference = CodingUserInfoKey(rawValue: "PyricFirestore.DocumentReference")!
}

// MARK: - @DocumentID Property Wrapper (firestore-swift#103)

/// A property wrapper that populates the document identifier (`String`) or `DocumentReference`
/// when decoding a `DocumentSnapshot`, and is omitted from write payloads when encoding.
@propertyWrapper
public struct DocumentID<Value: Sendable & Equatable>: Codable, Equatable, Sendable {
    public var wrappedValue: Value

    public init(wrappedValue: Value) {
        self.wrappedValue = wrappedValue
    }

    public init<V>() where Value == V? {
        self.wrappedValue = nil
    }

    public init(from decoder: Decoder) throws {
        if let ref = decoder.userInfo[.pyricDocumentReference] as? DocumentReference {
            if let idStr = ref.documentID as? Value {
                self.wrappedValue = idStr
                return
            }
            if let docRef = ref as? Value {
                self.wrappedValue = docRef
                return
            }
        }
        if let nilVal = Optional<Any>.none as? Value {
            self.wrappedValue = nilVal
            return
        }
        throw DecodingError.dataCorrupted(
            DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: "Cannot decode @DocumentID without document reference in decoder.userInfo"
            )
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(["__pyricDocumentIDOmitted": true])
    }
}

// MARK: - @ServerTimestamp Property Wrapper (firestore-swift#104)

/// A property wrapper that encodes `nil` as the `FieldValue.serverTimestamp()` sentinel
/// when writing to Firestore, and decodes timestamp values when reading.
@propertyWrapper
public struct ServerTimestamp<Value: Codable & Sendable & Equatable>: Codable, Equatable, Sendable {
    public var wrappedValue: Value

    public init(wrappedValue: Value) {
        self.wrappedValue = wrappedValue
    }

    public init<V>() where Value == V? {
        self.wrappedValue = nil
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            if let nilVal = Optional<Any>.none as? Value {
                self.wrappedValue = nilVal
                return
            }
        }
        if let ts = try? container.decode(Timestamp.self) {
            if let dateVal = ts.dateValue() as? Value {
                self.wrappedValue = dateVal
                return
            }
            if let tsVal = ts as? Value {
                self.wrappedValue = tsVal
                return
            }
        }
        self.wrappedValue = try container.decode(Value.self)
    }

    public func encode(to encoder: Encoder) throws {
        let mirror = Mirror(reflecting: wrappedValue)
        let isNil = (mirror.displayStyle == .optional && mirror.children.isEmpty)
        if isNil {
            var container = encoder.singleValueContainer()
            try container.encode(["__pyricServerTimestamp": true])
        } else {
            var container = encoder.singleValueContainer()
            try container.encode(wrappedValue)
        }
    }
}

// MARK: - Keyed Container Extensions for Property Wrappers

extension KeyedDecodingContainer {
    public func decode<Value>(_ type: DocumentID<Value>.Type, forKey key: Key) throws -> DocumentID<Value> {
        let ref = try superDecoder().userInfo[.pyricDocumentReference] as? DocumentReference
        if let ref {
            if let idStr = ref.documentID as? Value {
                return DocumentID(wrappedValue: idStr)
            }
            if let docRef = ref as? Value {
                return DocumentID(wrappedValue: docRef)
            }
        }
        if let nilVal = Optional<Any>.none as? Value {
            return DocumentID(wrappedValue: nilVal)
        }
        return try decodeIfPresent(type, forKey: key) ?? {
            throw DecodingError.keyNotFound(
                key,
                DecodingError.Context(codingPath: codingPath, debugDescription: "Missing @DocumentID value")
            )
        }()
    }

    public func decode<Value>(_ type: ServerTimestamp<Value>.Type, forKey key: Key) throws -> ServerTimestamp<Value> {
        if let wrapper = try decodeIfPresent(type, forKey: key) {
            return wrapper
        }
        if let nilVal = Optional<Any>.none as? Value {
            return ServerTimestamp(wrappedValue: nilVal)
        }
        throw DecodingError.keyNotFound(
            key,
            DecodingError.Context(codingPath: codingPath, debugDescription: "Missing @ServerTimestamp value")
        )
    }
}

extension KeyedEncodingContainer {
    public mutating func encode<Value>(_ value: DocumentID<Value>, forKey key: Key) throws {
        // Omit @DocumentID fields from write payloads
    }
}

// MARK: - Firestore.Encoder & Firestore.Decoder

extension Firestore {
    public final class Encoder: @unchecked Sendable {
        public var userInfo: [CodingUserInfoKey: Any] = [:]

        public init() {}

        public func encode<T: Encodable>(_ value: T) throws -> [String: Any] {
            let jsonEncoder = JSONEncoder()
            jsonEncoder.userInfo = userInfo
            jsonEncoder.dateEncodingStrategy = .custom { date, encoder in
                let ts = Timestamp(date: date)
                try ts.encode(to: encoder)
            }
            let data = try jsonEncoder.encode(value)
            guard let rawDict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw PyricFirestoreError.invalidArgument("Encoded top-level object must be a dictionary.")
            }
            return postProcessEncodedDictionary(rawDict)
        }

        private func postProcessEncodedDictionary(_ dict: [String: Any]) -> [String: Any] {
            var result: [String: Any] = [:]
            for (key, value) in dict {
                if let subDict = value as? [String: Any] {
                    if subDict["__pyricDocumentIDOmitted"] as? Bool == true {
                        continue
                    }
                    if subDict["__pyricServerTimestamp"] as? Bool == true {
                        result[key] = FieldValue.serverTimestamp()
                        continue
                    }
                    if subDict.count == 2,
                       let sec = subDict["seconds"] as? Int64 ?? (subDict["seconds"] as? Int).map(Int64.init),
                       let nano = subDict["nanoseconds"] as? Int32 ?? (subDict["nanoseconds"] as? Int).map(Int32.init) {
                        result[key] = Timestamp(seconds: sec, nanoseconds: nano)
                        continue
                    }
                    if subDict.count == 2,
                       let lat = subDict["latitude"] as? Double,
                       let lng = subDict["longitude"] as? Double {
                        result[key] = GeoPoint(latitude: lat, longitude: lng)
                        continue
                    }
                    result[key] = postProcessEncodedDictionary(subDict)
                } else if let arr = value as? [Any] {
                    result[key] = arr.map { item -> Any in
                        if let itemDict = item as? [String: Any] {
                            return postProcessEncodedDictionary(itemDict)
                        }
                        return item
                    }
                } else {
                    result[key] = value
                }
            }
            return result
        }
    }

    public final class Decoder: @unchecked Sendable {
        public var userInfo: [CodingUserInfoKey: Any] = [:]

        public init() {}

        public func decode<T: Decodable>(
            _ type: T.Type,
            from data: [String: Any],
            in reference: DocumentReference? = nil
        ) throws -> T {
            let prepared = preProcessDictionaryForDecoding(data)
            let jsonData = try JSONSerialization.data(withJSONObject: prepared)
            let jsonDecoder = JSONDecoder()
            var mergedInfo = userInfo
            if let reference {
                mergedInfo[.pyricDocumentReference] = reference
            }
            jsonDecoder.userInfo = mergedInfo
            jsonDecoder.dateDecodingStrategy = .custom { decoder in
                if let ts = try? Timestamp(from: decoder) {
                    return ts.dateValue()
                }
                let container = try decoder.singleValueContainer()
                if let seconds = try? container.decode(Double.self) {
                    return Date(timeIntervalSince1970: seconds)
                }
                if let isoString = try? container.decode(String.self),
                   let date = ISO8601DateFormatter().date(from: isoString) {
                    return date
                }
                throw DecodingError.dataCorrupted(
                    DecodingError.Context(
                        codingPath: decoder.codingPath,
                        debugDescription: "Expected Timestamp dictionary, epoch Double, or ISO8601 String for Date"
                    )
                )
            }
            return try jsonDecoder.decode(T.self, from: jsonData)
        }

        private func preProcessDictionaryForDecoding(_ dict: [String: Any]) -> [String: Any] {
            var result: [String: Any] = [:]
            for (key, value) in dict {
                if let ts = value as? Timestamp {
                    result[key] = ["seconds": ts.seconds, "nanoseconds": ts.nanoseconds]
                } else if let gp = value as? GeoPoint {
                    result[key] = ["latitude": gp.latitude, "longitude": gp.longitude]
                } else if let date = value as? Date {
                    let ts = Timestamp(date: date)
                    result[key] = ["seconds": ts.seconds, "nanoseconds": ts.nanoseconds]
                } else if let subDict = value as? [String: Any] {
                    result[key] = preProcessDictionaryForDecoding(subDict)
                } else if let arr = value as? [Any] {
                    result[key] = arr.map { item -> Any in
                        if let ts = item as? Timestamp {
                            return ["seconds": ts.seconds, "nanoseconds": ts.nanoseconds]
                        }
                        if let gp = item as? GeoPoint {
                            return ["latitude": gp.latitude, "longitude": gp.longitude]
                        }
                        if let sub = item as? [String: Any] {
                            return preProcessDictionaryForDecoding(sub)
                        }
                        return item
                    }
                } else {
                    result[key] = value
                }
            }
            return result
        }
    }
}

// MARK: - DocumentSnapshot & DocumentReference Codable Extensions (firestore-swift#105)

extension DocumentSnapshot {
    /// Decodes the document fields directly into a `Decodable` model type `T`.
    public func data<T: Decodable>(
        as type: T.Type,
        with serverTimestampBehavior: ServerTimestampBehavior = .none,
        decoder: Firestore.Decoder = Firestore.Decoder()
    ) throws -> T {
        guard let docData = data(with: serverTimestampBehavior) else {
            throw PyricFirestoreError.notFound("Document '\(reference.path)' does not exist or has no data.")
        }
        return try decoder.decode(type, from: docData, in: reference)
    }
}

extension DocumentReference {
    /// Encodes an `Encodable` value and writes it to the document at this reference.
    public func setData<T: Encodable>(
        from value: T,
        merge: Bool = false,
        encoder: Firestore.Encoder = Firestore.Encoder()
    ) async throws {
        let encodedDict = try encoder.encode(value)
        try await setData(encodedDict, merge: merge)
    }
}
