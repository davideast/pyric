import Foundation

public protocol ListenerRegistration: Sendable {
    func remove()
}

public final class SimpleListenerRegistration: ListenerRegistration, @unchecked Sendable {
    private var cleanup: (@Sendable () -> Void)?
    private let lock = NSLock()

    public init(cleanup: @escaping @Sendable () -> Void) {
        self.cleanup = cleanup
    }

    public func remove() {
        lock.lock()
        let toRun = cleanup
        cleanup = nil
        lock.unlock()
        toRun?()
    }
}

public typealias PyricListenerRegistration = SimpleListenerRegistration
