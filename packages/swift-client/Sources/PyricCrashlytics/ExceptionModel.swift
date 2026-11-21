import Foundation

/// Custom exception model reported via `Crashlytics.record(exceptionModel:)`,
/// mirroring `FirebaseCrashlytics.ExceptionModel` (`FIRExceptionModel` in `firebase-ios-sdk:13.2.0`).
public final class ExceptionModel: NSObject, @unchecked Sendable {
    private let lock = NSLock()
    private var _stackTrace: [StackFrame] = []
    private var _isFatal: Bool = false
    private var _onDemand: Bool = false

    /// Typically the type or class name of the exception.
    public let name: String

    /// Human-readable reason explaining why the exception occurred.
    public let reason: String

    /// Ordered stack frames (top-most frame first).
    public var stackTrace: [StackFrame] {
        get {
            lock.withLock { _stackTrace }
        }
        set {
            lock.withLock { _stackTrace = newValue }
        }
    }

    package var isFatal: Bool {
        get {
            lock.withLock { _isFatal }
        }
        set {
            lock.withLock { _isFatal = newValue }
        }
    }

    package var onDemand: Bool {
        get {
            lock.withLock { _onDemand }
        }
        set {
            lock.withLock { _onDemand = newValue }
        }
    }

    @available(*, unavailable, message: "Use init(name:reason:).")
    override public init() {
        fatalError("ExceptionModel cannot be initialized directly with init().")
    }

    /// Initializes an `ExceptionModel` with the required exception `name` and `reason`.
    public init(name: String, reason: String) {
        self.name = name
        self.reason = reason
        super.init()
    }

    package func snapshot() -> (name: String, reason: String, stackTrace: [StackFrame], isFatal: Bool, onDemand: Bool) {
        lock.withLock {
            (
                name: name,
                reason: reason,
                stackTrace: _stackTrace,
                isFatal: _isFatal,
                onDemand: _onDemand
            )
        }
    }
}
