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
        if contains(key) {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: self,
                debugDescription: "Field '\(key.stringValue)' conflicts with @DocumentID."
            )
        }
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
        throw DecodingError.keyNotFound(
            key,
            DecodingError.Context(codingPath: codingPath, debugDescription: "Missing @DocumentID context")
        )
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
            jsonEncoder.dataEncodingStrategy = .custom { blob, encoder in
                var container = encoder.singleValueContainer()
                try container.encode(["__pyricBytesBase64": blob.base64EncodedString()])
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
                if let subDict = value as? [String: Any],
                   subDict["__pyricDocumentIDOmitted"] as? Bool == true {
                    continue
                }
                result[key] = postProcessValue(value)
            }
            return result
        }

        private func postProcessValue(_ value: Any) -> Any {
            if let subDict = value as? [String: Any] {
                if subDict["__pyricServerTimestamp"] as? Bool == true {
                    return FieldValue.serverTimestamp()
                }
                if subDict.count == 1,
                   let b64 = subDict["__pyricBytesBase64"] as? String,
                   let blob = Data(base64Encoded: b64) {
                    return blob
                }
                if subDict.count == 1,
                   let refPath = subDict["__pyricDocRefPath"] as? String {
                    return DocumentReferenceHolder(path: refPath)
                }
                if subDict.count == 1,
                   let rawVec = subDict["__pyricVectorValues"] as? [Any] {
                    let doubles = rawVec.compactMap { ($0 as? NSNumber)?.doubleValue ?? ($0 as? Double) }
                    if doubles.count == rawVec.count {
                        return VectorValue(doubles)
                    }
                }
                if subDict.count == 2,
                   let sec = subDict["seconds"] as? Int64 ?? (subDict["seconds"] as? Int).map(Int64.init),
                   let nano = subDict["nanoseconds"] as? Int32 ?? (subDict["nanoseconds"] as? Int).map(Int32.init) {
                    return Timestamp(seconds: sec, nanoseconds: nano)
                }
                if subDict.count == 2,
                   let lat = subDict["latitude"] as? Double,
                   let lng = subDict["longitude"] as? Double {
                    return GeoPoint(latitude: lat, longitude: lng)
                }
                return postProcessEncodedDictionary(subDict)
            } else if let arr = value as? [Any] {
                return arr.map { postProcessValue($0) }
            }
            return value
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
            jsonDecoder.dataDecodingStrategy = .custom { decoder in
                if let keyed = try? decoder.container(keyedBy: PyricCodableMarkerKey.self),
                   let b64 = try? keyed.decode(String.self, forKey: .bytesBase64),
                   let decoded = Data(base64Encoded: b64) {
                    return decoded
                }
                let container = try decoder.singleValueContainer()
                if let b64 = try? container.decode(String.self),
                   let decoded = Data(base64Encoded: b64) {
                    return decoded
                }
                let rawBytes = try container.decode([UInt8].self)
                return Data(rawBytes)
            }
            return try jsonDecoder.decode(T.self, from: jsonData)
        }

        private func preProcessDictionaryForDecoding(_ dict: [String: Any]) -> [String: Any] {
            var result: [String: Any] = [:]
            for (key, value) in dict {
                result[key] = preProcessValue(value)
            }
            return result
        }

        private func preProcessValue(_ value: Any) -> Any {
            if let ts = value as? Timestamp {
                return ["seconds": ts.seconds, "nanoseconds": ts.nanoseconds]
            } else if let gp = value as? GeoPoint {
                return ["latitude": gp.latitude, "longitude": gp.longitude]
            } else if let date = value as? Date {
                let ts = Timestamp(date: date)
                return ["seconds": ts.seconds, "nanoseconds": ts.nanoseconds]
            } else if let blob = value as? Data {
                return ["__pyricBytesBase64": blob.base64EncodedString()]
            } else if let vec = value as? VectorValue {
                return ["__pyricVectorValues": vec.values]
            } else if let ref = value as? PathReferenceable {
                return ["__pyricDocRefPath": ref.path]
            } else if let subDict = value as? [String: Any] {
                return preProcessDictionaryForDecoding(subDict)
            } else if let arr = value as? [Any] {
                return arr.map { preProcessValue($0) }
            }
            return value
        }
    }
}

private enum PyricCodableMarkerKey: String, CodingKey {
    case bytesBase64 = "__pyricBytesBase64"
    case docRefPath = "__pyricDocRefPath"
}

extension DocumentReference: Codable {
    public convenience init(from decoder: Decoder) throws {
        guard let contextRef = decoder.userInfo[.pyricDocumentReference] as? DocumentReference else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Cannot decode DocumentReference without Firestore document context."
                )
            )
        }
        let container = try decoder.container(keyedBy: PyricCodableMarkerKey.self)
        let refPath = try container.decode(String.self, forKey: .docRefPath)
        self.init(firestore: contextRef.firestore, path: refPath)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: PyricCodableMarkerKey.self)
        try container.encode(path, forKey: .docRefPath)
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

    public func setData<T: Encodable>(
        from value: T,
        merge: Bool = false,
        encoder: Firestore.Encoder = Firestore.Encoder(),
        completion: (@Sendable (Error?) -> Void)?
    ) throws {
        let encodedDict = try encoder.encode(value)
        setData(encodedDict, merge: merge, completion: completion)
    }

    public func setData<T: Encodable>(
        from value: T,
        mergeFields: [Any],
        encoder: Firestore.Encoder = Firestore.Encoder()
    ) async throws {
        let encodedDict = try encoder.encode(value)
        try await setData(encodedDict, mergeFields: mergeFields)
    }

    public func setData<T: Encodable>(
        from value: T,
        mergeFields: [Any],
        encoder: Firestore.Encoder = Firestore.Encoder(),
        completion: (@Sendable (Error?) -> Void)?
    ) throws {
        let encodedDict = try encoder.encode(value)
        setData(encodedDict, mergeFields: mergeFields, completion: completion)
    }
}

extension CollectionReference {
    @discardableResult
    public func addDocument<T: Encodable>(
        from value: T,
        encoder: Firestore.Encoder = Firestore.Encoder()
    ) async throws -> DocumentReference {
        let docRef = document()
        try await docRef.setData(from: value, encoder: encoder)
        return docRef
    }

    @_disfavoredOverload
    @discardableResult
    public func addDocument<T: Encodable>(
        from value: T,
        encoder: Firestore.Encoder = Firestore.Encoder(),
        completion: (@Sendable (Error?) -> Void)? = nil
    ) throws -> DocumentReference {
        let docRef = document()
        try docRef.setData(from: value, encoder: encoder, completion: completion)
        return docRef
    }
}
