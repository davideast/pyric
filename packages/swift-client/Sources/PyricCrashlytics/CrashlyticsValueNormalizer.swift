import Foundation
import PyricFirestore

/// Strictly FIFO serial task queue preserving call ordering across synchronous Crashlytics
/// mutations (`log`, `setUserID`, `setCustomValue`, `record`) and async sync barriers (`flush`, `getState`).
package final class CrashlyticsSerialQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    private var closed = false

    package init() {}

    package func enqueueFireAndForget(_ work: @escaping @Sendable () async -> Void) {
        lock.withLock {
            guard !closed else { return }
            let previous = tail
            tail = Task {
                await previous?.value
                await work()
            }
        }
    }

    package func enqueue<T: Sendable>(
        _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let job: Task<T, any Error> = try lock.withLock {
            if closed {
                throw CrashlyticsError(
                    code: .cancelled,
                    message: "Crashlytics instance has been disconnected."
                )
            }
            let previous = tail
            let created = Task<T, any Error> {
                await previous?.value
                return try await work()
            }
            tail = Task {
                _ = try? await created.value
            }
            return created
        }
        return try await job.value
    }

    package func closeAndDrain() async {
        let pending: Task<Void, Never>? = lock.withLock {
            closed = true
            let current = tail
            tail = nil
            return current
        }
        await pending?.value
    }
}

private protocol _CrashlyticsOptionalBox {
    var crashlyticsBoxedValue: Any? { get }
}

extension Optional: _CrashlyticsOptionalBox {
    var crashlyticsBoxedValue: Any? { self }
}

/// Normalizes Swift and Foundation values into Crashlytics plain wire scalars and error fields.
package enum CrashlyticsValueNormalizer {
    private static let maxCauseDepth = 16

    package static func normalizeCustomValue(_ raw: Any?) -> AnySendable {
        guard var current = raw else {
            return .null
        }
        while let box = current as? any _CrashlyticsOptionalBox {
            guard let inner = box.crashlyticsBoxedValue else {
                return .null
            }
            current = inner
        }
        guard !(current is NSNull) else {
            return .null
        }
        if let num = current as? NSNumber {
            if NSNumberInspector.isBoolean(num) {
                return .bool(num.boolValue)
            }
            if NSNumberInspector.isFloatingPoint(num) {
                let d = num.doubleValue
                return d.isFinite ? .double(d) : .string(String(d))
            }
            return .int(num.int64Value)
        }
        if let b = current as? Bool { return .bool(b) }
        if let i = current as? Int { return .int(Int64(i)) }
        if let i64 = current as? Int64 { return .int(i64) }
        if let i32 = current as? Int32 { return .int(Int64(i32)) }
        if let i16 = current as? Int16 { return .int(Int64(i16)) }
        if let i8 = current as? Int8 { return .int(Int64(i8)) }
        if let u = current as? UInt {
            return u <= UInt(Int64.max) ? .int(Int64(u)) : .string(String(u))
        }
        if let u64 = current as? UInt64 {
            return u64 <= UInt64(Int64.max) ? .int(Int64(u64)) : .string(String(u64))
        }
        if let u32 = current as? UInt32 { return .int(Int64(u32)) }
        if let u16 = current as? UInt16 { return .int(Int64(u16)) }
        if let u8 = current as? UInt8 { return .int(Int64(u8)) }
        if let d = current as? Double {
            return d.isFinite ? .double(d) : .string(String(d))
        }
        if let f = current as? Float {
            if f.isFinite, let exact = Double(String(f)) {
                return .double(exact)
            }
            return f.isFinite ? .double(Double(f)) : .string(String(f))
        }
        if let s = current as? String { return .string(s) }
        if let sub = current as? Substring { return .string(String(sub)) }
        return .string(String(describing: current))
    }

    package static func normalizeError(
        _ error: any Error,
        extraUserInfo: [String: Any]?,
        capturedStackSymbols: [String]
    ) -> (
        name: String,
        message: String,
        code: String,
        cause: String?,
        stack: String?,
        attributes: [String: AnySendable]
    ) {
        let nsError = error as NSError
        let resolvedName = nsError.domain.isEmpty ? String(describing: type(of: error)) : nsError.domain
        let resolvedCode = String(nsError.code)

        let message: String
        if let explicitDesc = nsError.userInfo[NSLocalizedDescriptionKey] as? String, !explicitDesc.isEmpty {
            message = explicitDesc
        } else if let reason = nsError.userInfo[NSLocalizedFailureReasonErrorKey] as? String, !reason.isEmpty {
            message = reason
        } else {
            let localized = error.localizedDescription
            message = localized.isEmpty ? String(describing: error) : localized
        }

        let cause = formatUnderlyingCauseChain(from: nsError)
        let stack: String?
        if !capturedStackSymbols.isEmpty {
            stack = capturedStackSymbols.joined(separator: "\n")
        } else {
            stack = "\(resolvedName) (\(resolvedCode)): \(message)"
        }

        var attributes: [String: AnySendable] = [:]
        for (key, value) in nsError.userInfo {
            if key == NSUnderlyingErrorKey || key == "NSMultipleUnderlyingErrorsKey" {
                continue
            }
            attributes[key] = normalizeCustomValue(value)
        }
        if let extraUserInfo {
            for (key, value) in extraUserInfo {
                attributes[key] = normalizeCustomValue(value)
            }
        }

        return (
            name: resolvedName,
            message: message,
            code: resolvedCode,
            cause: cause,
            stack: stack,
            attributes: attributes
        )
    }

    private static func formatUnderlyingCauseChain(from rootError: NSError) -> String? {
        guard let initial = rootError.userInfo[NSUnderlyingErrorKey] as? NSError
                ?? (rootError.userInfo[NSUnderlyingErrorKey] as? any Error).map({ $0 as NSError }) else {
            return nil
        }
        var seen = Set<ObjectIdentifier>()
        seen.insert(ObjectIdentifier(rootError))
        var parts: [String] = []
        var current: NSError? = initial
        var depth = 0
        while let err = current, depth < maxCauseDepth {
            let id = ObjectIdentifier(err)
            if !seen.insert(id).inserted {
                parts.append("[CIRCULAR REFERENCE: \(err.domain)(\(err.code))]")
                break
            }
            let desc = (err.userInfo[NSLocalizedDescriptionKey] as? String) ?? err.localizedDescription
            if desc.isEmpty {
                parts.append("\(err.domain)(\(err.code))")
            } else {
                parts.append("\(err.domain)(\(err.code)): \(desc)")
            }
            if let next = err.userInfo[NSUnderlyingErrorKey] as? NSError {
                current = next
            } else if let nextErr = err.userInfo[NSUnderlyingErrorKey] as? any Error {
                current = nextErr as NSError
            } else {
                current = nil
            }
            depth += 1
        }
        return parts.isEmpty ? nil : parts.joined(separator: " <- ")
    }
}
