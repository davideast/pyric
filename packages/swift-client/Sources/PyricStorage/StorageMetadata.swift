import Foundation
import PyricFirestore

/// Represents the metadata on an object in Firebase Cloud Storage, mirroring `StorageMetadata` (`13.2.0`).
open class StorageMetadata: NSObject, @unchecked Sendable {
    public enum StorageMetadataType: Int, Sendable {
        case unknown = 0
        case file = 1
        case folder = 2
    }

    public let bucket: String
    public let generation: Int64
    public let metageneration: Int64
    public let size: Int64
    public let timeCreated: Date?
    public let updated: Date?
    public let md5Hash: String?

    private let stateLock = NSLock()
    private var _name: String?
    private var _path: String?
    private var _cacheControl: String?
    private var _contentDisposition: String?
    private var _contentEncoding: String?
    private var _contentLanguage: String?
    private var _contentType: String?
    private var _customMetadata: [String: String]?
    private var _fileType: StorageMetadataType

    private var _touchedFields: Set<String> = []
    private let initialSettableFields: [String: String]
    private let initialCustomMetadata: [String: String]?

    public package(set) var name: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _name
        }
        set {
            stateLock.lock()
            _name = newValue
            stateLock.unlock()
        }
    }

    public package(set) var path: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _path
        }
        set {
            stateLock.lock()
            _path = newValue
            stateLock.unlock()
        }
    }

    public var cacheControl: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _cacheControl
        }
        set {
            stateLock.lock()
            _cacheControl = newValue
            _touchedFields.insert("cacheControl")
            stateLock.unlock()
        }
    }

    public var contentDisposition: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _contentDisposition
        }
        set {
            stateLock.lock()
            _contentDisposition = newValue
            _touchedFields.insert("contentDisposition")
            stateLock.unlock()
        }
    }

    public var contentEncoding: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _contentEncoding
        }
        set {
            stateLock.lock()
            _contentEncoding = newValue
            _touchedFields.insert("contentEncoding")
            stateLock.unlock()
        }
    }

    public var contentLanguage: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _contentLanguage
        }
        set {
            stateLock.lock()
            _contentLanguage = newValue
            _touchedFields.insert("contentLanguage")
            stateLock.unlock()
        }
    }

    public var contentType: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _contentType
        }
        set {
            stateLock.lock()
            _contentType = newValue
            _touchedFields.insert("contentType")
            stateLock.unlock()
        }
    }

    public var customMetadata: [String: String]? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _customMetadata
        }
        set {
            stateLock.lock()
            _customMetadata = newValue
            _touchedFields.insert("customMetadata")
            stateLock.unlock()
        }
    }

    public var isFile: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _fileType == .file
    }

    public var isFolder: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _fileType == .folder
    }

    override public convenience init() {
        self.init(dictionary: [:])
    }

    public init(dictionary: [String: AnyHashable]) {
        self.bucket = Self.unwrapString(dictionary["bucket"]) ?? ""
        self._cacheControl = Self.unwrapString(dictionary["cacheControl"])
        self._contentDisposition = Self.unwrapString(dictionary["contentDisposition"])
        self._contentEncoding = Self.unwrapString(dictionary["contentEncoding"])
        self._contentLanguage = Self.unwrapString(dictionary["contentLanguage"])
        self._contentType = Self.unwrapString(dictionary["contentType"])
        if let custom = Self.unwrapStringMap(dictionary["metadata"]) {
            self._customMetadata = custom
        } else if let custom = Self.unwrapStringMap(dictionary["customMetadata"]) {
            self._customMetadata = custom
        } else {
            self._customMetadata = nil
        }

        self.size = Self.parseInt64(dictionary["size"])
        self.generation = Self.parseInt64(dictionary["generation"])
        self.metageneration = Self.parseInt64(dictionary["metageneration"])
        self.timeCreated = Self.parseRFC3339Date(dictionary["timeCreated"])
        self.updated = Self.parseRFC3339Date(dictionary["updated"])
        self.md5Hash = Self.unwrapString(dictionary["md5Hash"])

        if let fullPath = Self.unwrapString(dictionary["fullPath"]) ?? Self.unwrapString(dictionary["name"]) {
            let normalized = ParsedStorageLocation.normalizePath(fullPath)
            self._path = normalized
            if let explicitName = Self.unwrapString(dictionary["objectName"]) {
                self._name = explicitName
            } else {
                self._name = ParsedStorageLocation.lastComponent(of: normalized)
            }
            self._fileType = .file
        } else {
            self._path = nil
            self._name = nil
            self._fileType = .unknown
        }

        var initialSettable: [String: String] = [:]
        if let v = self._cacheControl { initialSettable["cacheControl"] = v }
        if let v = self._contentDisposition { initialSettable["contentDisposition"] = v }
        if let v = self._contentEncoding { initialSettable["contentEncoding"] = v }
        if let v = self._contentLanguage { initialSettable["contentLanguage"] = v }
        if let v = self._contentType { initialSettable["contentType"] = v }
        self.initialSettableFields = initialSettable
        self.initialCustomMetadata = self._customMetadata
        super.init()
    }

    open func dictionaryRepresentation() -> [String: AnyHashable] {
        stateLock.lock()
        let currentCacheControl = _cacheControl
        let currentDisposition = _contentDisposition
        let currentEncoding = _contentEncoding
        let currentLanguage = _contentLanguage
        let currentContentType = _contentType
        let currentCustom = _customMetadata
        let currentPath = _path
        stateLock.unlock()

        var out: [String: AnyHashable] = [:]
        out["bucket"] = bucket
        if let currentCacheControl { out["cacheControl"] = currentCacheControl }
        if let currentDisposition { out["contentDisposition"] = currentDisposition }
        if let currentEncoding { out["contentEncoding"] = currentEncoding }
        if let currentLanguage { out["contentLanguage"] = currentLanguage }
        if let currentContentType { out["contentType"] = currentContentType }
        if let md5Hash { out["md5Hash"] = md5Hash }
        if size != 0 { out["size"] = size }
        if generation != 0 { out["generation"] = "\(generation)" }
        if metageneration != 0 { out["metageneration"] = "\(metageneration)" }
        if let timeCreated { out["timeCreated"] = Self.formatRFC3339Date(timeCreated) }
        if let updated { out["updated"] = Self.formatRFC3339Date(updated) }
        if let currentPath { out["name"] = currentPath }
        if let currentCustom { out["metadata"] = currentCustom }
        return out
    }

    override open func copy() -> Any {
        StorageMetadata(dictionary: dictionaryRepresentation())
    }

    override open func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? StorageMetadata else {
            return false
        }
        return dictionaryRepresentation() == other.dictionaryRepresentation()
    }

    override public var hash: Int {
        dictionaryRepresentation().hashValue
    }

    override public var description: String {
        "\(type(of: self)) \(dictionaryRepresentation())"
    }

    // MARK: - Package Wire Codecs

    package static func fromWire(_ raw: AnySendable, fallbackBucket: String) throws -> StorageMetadata {
        guard let dict = raw.dictionaryValue else {
            throw StorageErrorCode(
                code: .internalError,
                message: "Storage metadata response from Pyric bridge was not an object."
            )
        }
        var mapped: [String: AnyHashable] = [:]
        let resolvedBucket = dict["bucket"]?.stringValue ?? fallbackBucket
        mapped["bucket"] = resolvedBucket

        if let fullPath = dict["fullPath"]?.stringValue {
            mapped["fullPath"] = fullPath
            mapped["name"] = fullPath
        } else if let name = dict["name"]?.stringValue {
            mapped["name"] = name
        }
        if let objectName = dict["name"]?.stringValue, dict["fullPath"]?.stringValue != nil {
            mapped["objectName"] = objectName
        }
        if let sizeInt = dict["size"]?.intValue {
            mapped["size"] = sizeInt
        } else if let sizeDbl = dict["size"]?.doubleValue {
            mapped["size"] = Int64(sizeDbl)
        } else if let sizeStr = dict["size"]?.stringValue, let parsed = Int64(sizeStr) {
            mapped["size"] = parsed
        }
        if let genStr = dict["generation"]?.stringValue {
            mapped["generation"] = genStr
        } else if let genInt = dict["generation"]?.intValue {
            mapped["generation"] = "\(genInt)"
        }
        if let metaGenStr = dict["metageneration"]?.stringValue {
            mapped["metageneration"] = metaGenStr
        } else if let metaGenInt = dict["metageneration"]?.intValue {
            mapped["metageneration"] = "\(metaGenInt)"
        }
        if let created = dict["timeCreated"]?.stringValue { mapped["timeCreated"] = created }
        if let updated = dict["updated"]?.stringValue { mapped["updated"] = updated }
        if let md5 = dict["md5Hash"]?.stringValue { mapped["md5Hash"] = md5 }
        if let cc = dict["cacheControl"]?.stringValue { mapped["cacheControl"] = cc }
        if let cd = dict["contentDisposition"]?.stringValue { mapped["contentDisposition"] = cd }
        if let ce = dict["contentEncoding"]?.stringValue { mapped["contentEncoding"] = ce }
        if let cl = dict["contentLanguage"]?.stringValue { mapped["contentLanguage"] = cl }
        if let ct = dict["contentType"]?.stringValue { mapped["contentType"] = ct }

        let rawCustom = dict["customMetadata"]?.dictionaryValue ?? dict["metadata"]?.dictionaryValue
        if let rawCustom {
            var custom: [String: String] = [:]
            for (key, value) in rawCustom {
                if let str = value.stringValue {
                    custom[key] = str
                }
            }
            mapped["metadata"] = custom
        }
        return StorageMetadata(dictionary: mapped)
    }

    package func toUploadSettableWire() -> (contentType: String?, metadata: [String: AnySendable]?) {
        stateLock.lock()
        let cc = _cacheControl
        let cd = _contentDisposition
        let ce = _contentEncoding
        let cl = _contentLanguage
        let ct = _contentType
        let custom = _customMetadata
        stateLock.unlock()

        var wire: [String: AnySendable] = [:]
        if let ct, !ct.isEmpty { wire["contentType"] = .string(ct) }
        if let cc { wire["cacheControl"] = .string(cc) }
        if let cd { wire["contentDisposition"] = .string(cd) }
        if let ce { wire["contentEncoding"] = .string(ce) }
        if let cl { wire["contentLanguage"] = .string(cl) }
        if let custom {
            var customWire: [String: AnySendable] = [:]
            for (key, value) in custom {
                customWire[key] = .string(value)
            }
            wire["customMetadata"] = .dictionary(customWire)
        }
        let nonEmptyContentType = (ct?.isEmpty == false) ? ct : nil
        return (contentType: nonEmptyContentType, metadata: wire.isEmpty ? nil : wire)
    }

    /// Encodes `StorageMetadataPatchWire` for `storage.setMetadata`, clearing removed keys with `.null`.
    package func toAdminPatchWire(existingCustomKeys: Set<String>) -> [String: AnySendable] {
        stateLock.lock()
        let currentValues: [String: String?] = [
            "contentType": _contentType,
            "cacheControl": _cacheControl,
            "contentDisposition": _contentDisposition,
            "contentEncoding": _contentEncoding,
            "contentLanguage": _contentLanguage
        ]
        let currentCustom = _customMetadata
        let touched = _touchedFields
        stateLock.unlock()

        var settableWire: [String: AnySendable] = [:]
        for (field, value) in currentValues {
            if let value {
                if initialSettableFields[field] != value || touched.contains(field) {
                    settableWire[field] = .string(value)
                }
            } else if initialSettableFields[field] != nil || touched.contains(field) {
                settableWire[field] = .null
            }
        }

        var patch: [String: AnySendable] = [:]
        if !settableWire.isEmpty {
            patch["settable"] = .dictionary(settableWire)
        }

        let customWasProvided = touched.contains("customMetadata") || initialCustomMetadata != nil
        if customWasProvided {
            var customPatch: [String: AnySendable] = [:]
            let desired = currentCustom ?? [:]
            for key in existingCustomKeys where desired[key] == nil {
                customPatch[key] = .null
            }
            if let initialCustomMetadata {
                for key in initialCustomMetadata.keys where desired[key] == nil {
                    customPatch[key] = .null
                }
            }
            for (key, val) in desired {
                customPatch[key] = .string(val)
            }
            if !customPatch.isEmpty {
                patch["customMetadata"] = .dictionary(customPatch)
            }
        }
        return patch
    }

    // MARK: - Date & Number Helpers

    private static func unwrapAny(_ raw: Any?) -> Any? {
        guard let raw else { return nil }
        if let hashable = raw as? AnyHashable {
            return hashable.base
        }
        return raw
    }

    private static func unwrapString(_ raw: Any?) -> String? {
        unwrapAny(raw) as? String
    }

    private static func unwrapStringMap(_ raw: Any?) -> [String: String]? {
        guard let unwrapped = unwrapAny(raw) else { return nil }
        if let direct = unwrapped as? [String: String] {
            return direct
        }
        if let hashableDict = unwrapped as? [AnyHashable: Any] {
            var out: [String: String] = [:]
            for (k, v) in hashableDict {
                if let keyStr = unwrapString(k), let valStr = unwrapString(v) {
                    out[keyStr] = valStr
                }
            }
            return out
        }
        return nil
    }

    private static func parseInt64(_ raw: Any?) -> Int64 {
        guard let unwrapped = unwrapAny(raw) else { return 0 }
        if let i64 = unwrapped as? Int64 { return i64 }
        if let i = unwrapped as? Int { return Int64(i) }
        if let num = unwrapped as? NSNumber { return num.int64Value }
        if let str = unwrapped as? String, let parsed = Int64(str) { return parsed }
        return 0
    }

    private static func parseRFC3339Date(_ raw: Any?) -> Date? {
        guard let str = unwrapString(raw), !str.isEmpty else {
            return nil
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: str) {
            return parsed
        }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: str)
    }

    package static func formatRFC3339Date(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
