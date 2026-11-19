import Foundation

/// Monotonic clock and cancellable sleeper used by `PyricBridgeClient` for
/// heartbeat intervals, liveness silence detection, reconnect backoff, and
/// hold, attach, and operation deadlines.
protocol BridgeClock: Sendable {
    /// Monotonic seconds elapsed since an arbitrary fixed epoch of this clock.
    func now() -> TimeInterval
    /// Suspends for `seconds` (returning immediately when `<= 0`) or throws on task cancellation.
    func sleep(seconds: TimeInterval) async throws
}

extension BridgeClock {
    /// Suspends until `now()` reaches `deadline` (returning immediately if already reached).
    func sleepUntil(deadline: TimeInterval) async throws {
        try await sleep(seconds: deadline - now())
    }
}

/// Production clock backed by `ContinuousClock` and `Task.sleep`.
struct ContinuousBridgeClock: BridgeClock {
    private let clock: ContinuousClock
    private let origin: ContinuousClock.Instant

    init() {
        let continuous = ContinuousClock()
        self.clock = continuous
        self.origin = continuous.now
    }

    func now() -> TimeInterval {
        let parts = origin.duration(to: clock.now).components
        return Double(parts.seconds) + Double(parts.attoseconds) / 1e18
    }

    func sleep(seconds: TimeInterval) async throws {
        try Task.checkCancellation()
        guard seconds > 0 else { return }
        let clamped = min(seconds, 31_536_000)
        let nanos = UInt64((clamped * 1_000_000_000).rounded())
        try await Task.sleep(nanoseconds: nanos)
    }
}
