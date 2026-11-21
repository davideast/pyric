import Foundation
import PyricFirestore

/// Typed scalar value stored in Crashlytics custom keys and report attributes.
public enum CrashlyticsCustomValue: Sendable, Equatable {
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var intValue: Int64? {
        if case .int(let i) = self { return i }
        return nil
    }

    public var doubleValue: Double? {
        if case .double(let d) = self { return d }
        if case .int(let i) = self { return Double(i) }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    package static func fromWire(_ raw: AnySendable) -> CrashlyticsCustomValue? {
        switch raw {
        case .bool(let b):
            return .bool(b)
        case .int(let i):
            return .int(i)
        case .double(let d):
            return .double(d)
        case .string(let s):
            return .string(s)
        case .null, .array, .dictionary:
            return nil
        }
    }

    package static func decodeMap(_ raw: AnySendable?) -> [String: CrashlyticsCustomValue] {
        guard let dict = raw?.dictionaryValue else {
            return [:]
        }
        var out: [String: CrashlyticsCustomValue] = [:]
        for (key, value) in dict {
            if let mapped = fromWire(value) {
                out[key] = mapped
            }
        }
        return out
    }
}

/// Single Crashlytics log or breadcrumb entry stored in the per-app ring buffer.
public struct CrashlyticsBreadcrumbEntry: Sendable, Equatable {
    public let message: String
    public let timestampMs: Int64
    public let attributes: [String: CrashlyticsCustomValue]

    public init(
        message: String,
        timestampMs: Int64,
        attributes: [String: CrashlyticsCustomValue] = [:]
    ) {
        self.message = message
        self.timestampMs = timestampMs
        self.attributes = attributes
    }

    package func toWire() -> AnySendable {
        var payload: [String: AnySendable] = [
            "message": .string(message),
            "timestampMs": .int(timestampMs),
        ]
        if !attributes.isEmpty {
            var wireAttrs: [String: AnySendable] = [:]
            for (k, v) in attributes {
                switch v {
                case .bool(let b): wireAttrs[k] = .bool(b)
                case .int(let i): wireAttrs[k] = .int(i)
                case .double(let d): wireAttrs[k] = .double(d)
                case .string(let s): wireAttrs[k] = .string(s)
                }
            }
            payload["attributes"] = .dictionary(wireAttrs)
        }
        return .dictionary(payload)
    }

    package static func fromWire(_ raw: AnySendable) -> CrashlyticsBreadcrumbEntry? {
        guard let dict = raw.dictionaryValue,
              let message = dict["message"]?.stringValue else {
            return nil
        }
        let ts: Int64
        if let exact = dict["timestampMs"]?.intValue {
            ts = exact
        } else if let dbl = dict["timestampMs"]?.doubleValue {
            ts = Int64(dbl.rounded())
        } else {
            ts = 0
        }
        return CrashlyticsBreadcrumbEntry(
            message: message,
            timestampMs: ts,
            attributes: CrashlyticsCustomValue.decodeMap(dict["attributes"])
        )
    }
}

/// Recorded Crashlytics report returned inside `CrashlyticsStateSnapshot`.
public struct CrashlyticsRecordedReport: Sendable, Equatable {
    public let reportID: String
    public let appID: String
    public let name: String
    public let message: String
    public let stack: String?
    public let code: String?
    public let cause: String?
    public let fatal: Bool
    public let attributes: [String: CrashlyticsCustomValue]
    public let customKeys: [String: CrashlyticsCustomValue]
    public let userID: String?
    public let breadcrumbs: [CrashlyticsBreadcrumbEntry]
    public let timestampMs: Int64
    public let appVersion: String?
    public let region: String?
    public let sdkPlatform: String
    public let flushed: Bool

    package static func fromWire(_ raw: AnySendable) -> CrashlyticsRecordedReport? {
        guard let dict = raw.dictionaryValue,
              let reportID = dict["reportId"]?.stringValue else {
            return nil
        }
        let ts: Int64
        if let exact = dict["timestampMs"]?.intValue {
            ts = exact
        } else if let dbl = dict["timestampMs"]?.doubleValue {
            ts = Int64(dbl.rounded())
        } else {
            ts = 0
        }
        let crumbs = (dict["breadcrumbs"]?.arrayValue ?? []).compactMap(CrashlyticsBreadcrumbEntry.fromWire)
        return CrashlyticsRecordedReport(
            reportID: reportID,
            appID: dict["appId"]?.stringValue ?? "default",
            name: dict["name"]?.stringValue ?? "Error",
            message: dict["message"]?.stringValue ?? "",
            stack: dict["stack"]?.stringValue,
            code: dict["code"]?.stringValue,
            cause: dict["cause"]?.stringValue,
            fatal: dict["fatal"]?.boolValue ?? false,
            attributes: CrashlyticsCustomValue.decodeMap(dict["attributes"]),
            customKeys: CrashlyticsCustomValue.decodeMap(dict["customKeys"]),
            userID: dict["userId"]?.stringValue,
            breadcrumbs: crumbs,
            timestampMs: ts,
            appVersion: dict["appVersion"]?.stringValue,
            region: dict["region"]?.stringValue,
            sdkPlatform: dict["sdkPlatform"]?.stringValue ?? "ios",
            flushed: dict["flushed"]?.boolValue ?? false
        )
    }
}

/// Inspectable per-app sandbox state returned by `Crashlytics.getState()`.
public struct CrashlyticsStateSnapshot: Sendable, Equatable {
    public let collectionEnabled: Bool
    public let userID: String?
    public let customKeys: [String: CrashlyticsCustomValue]
    public let appVersion: String?
    public let region: String?
    public let didCrashOnPreviousExecution: Bool
    public let logs: [CrashlyticsBreadcrumbEntry]
    public let reports: [CrashlyticsRecordedReport]
    public let unsentReports: [CrashlyticsRecordedReport]

    package static func fromWire(_ raw: AnySendable) throws -> CrashlyticsStateSnapshot {
        guard let dict = raw.dictionaryValue else {
            throw CrashlyticsError(
                code: .unknown,
                message: "crashlytics.getState response from Pyric bridge was not an object."
            )
        }
        let logs = (dict["logs"]?.arrayValue ?? []).compactMap(CrashlyticsBreadcrumbEntry.fromWire)
        let reports = (dict["reports"]?.arrayValue ?? []).compactMap(CrashlyticsRecordedReport.fromWire)
        let unsent = (dict["unsentReports"]?.arrayValue ?? []).compactMap(CrashlyticsRecordedReport.fromWire)
        return CrashlyticsStateSnapshot(
            collectionEnabled: dict["collectionEnabled"]?.boolValue ?? true,
            userID: dict["userId"]?.stringValue,
            customKeys: CrashlyticsCustomValue.decodeMap(dict["customKeys"]),
            appVersion: dict["appVersion"]?.stringValue,
            region: dict["region"]?.stringValue,
            didCrashOnPreviousExecution: dict["didCrashOnPreviousExecution"]?.boolValue ?? false,
            logs: logs,
            reports: reports,
            unsentReports: unsent
        )
    }
}
