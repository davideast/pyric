import Foundation

/// Configuration options for an `HTTPSCallable` or `Callable` reference,
/// matching `FirebaseFunctions.HTTPSCallableOptions` (`13.2.0`).
public final class HTTPSCallableOptions: NSObject, Sendable {
    /// Whether to protect the callable invocation with a single-use limited-use App Check token.
    public let requireLimitedUseAppCheckTokens: Bool

    public init(requireLimitedUseAppCheckTokens: Bool) {
        self.requireLimitedUseAppCheckTokens = requireLimitedUseAppCheckTokens
        super.init()
    }

    public override convenience init() {
        self.init(requireLimitedUseAppCheckTokens: false)
    }
}
