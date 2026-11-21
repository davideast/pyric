import Foundation
@testable import PyricFirestore

/// Deterministic manual clock for bridge reconnect, heartbeat, liveness, and
/// hold-deadline tests. Virtual time advances in integer nanoseconds only when
/// `advance(by:)` is called, eliminating CI scheduler-stall races.
final class TestBridgeClock: BridgeClock, @unchecked Sendable {
    private struct Sleeper {
        let id: UUID
        let wakeAtNanos: Int64
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var currentNanos: Int64 = 0
    private var sleepers: [Sleeper] = []

    private static func toNanos(_ seconds: TimeInterval) -> Int64 {
        let clamped = min(max(0, seconds), 31_536_000)
        return Int64((clamped * 1_000_000_000).rounded())
    }

    func now() -> TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return Double(currentNanos) / 1_000_000_000.0
    }

    var sleeperCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return sleepers.count
    }

    /// Milliseconds until the earliest parked sleeper wakes, or `nil` when none is waiting.
    var nextWakeMilliseconds: Int? {
        lock.lock()
        defer { lock.unlock() }
        guard let earliest = sleepers.min(by: { $0.wakeAtNanos < $1.wakeAtNanos }) else {
            return nil
        }
        let delta = max(0, earliest.wakeAtNanos - currentNanos)
        return Int(delta / 1_000_000)
    }

    private enum WakeTarget: Sendable {
        case relative(Int64)
        case absolute(Int64)
    }

    func sleep(seconds: TimeInterval) async throws {
        try Task.checkCancellation()
        let deltaNanos = Self.toNanos(seconds)
        guard deltaNanos > 0 else { return }
        try await park(target: .relative(deltaNanos))
    }

    /// Evaluates the absolute deadline under `lock` so a concurrent `advance(by:)`
    /// cannot push a deadline sleeper past its target virtual time.
    func sleepUntil(deadline: TimeInterval) async throws {
        try Task.checkCancellation()
        try await park(target: .absolute(Self.toNanos(deadline)))
    }

    private func park(target: WakeTarget) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                self.lock.lock()
                if Task.isCancelled {
                    self.lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                let wakeAt: Int64
                switch target {
                case .relative(let deltaNanos):
                    wakeAt = self.currentNanos + deltaNanos
                case .absolute(let deadlineNanos):
                    wakeAt = deadlineNanos
                }
                if wakeAt <= self.currentNanos {
                    self.lock.unlock()
                    continuation.resume()
                    return
                }
                self.sleepers.append(Sleeper(id: id, wakeAtNanos: wakeAt, continuation: continuation))
                self.lock.unlock()
            }
        } onCancel: {
            self.cancelSleeper(id: id)
        }
    }

    private func cancelSleeper(id: UUID) {
        lock.lock()
        guard let index = sleepers.firstIndex(where: { $0.id == id }) else {
            lock.unlock()
            return
        }
        let cancelled = sleepers.remove(at: index)
        lock.unlock()
        cancelled.continuation.resume(throwing: CancellationError())
    }

    /// Advances virtual time by `seconds` and wakes every sleeper whose deadline
    /// is at or before the new clock time in chronological order.
    func advance(by seconds: TimeInterval) {
        let stepNanos = Self.toNanos(seconds)
        guard stepNanos > 0 else { return }
        lock.lock()
        currentNanos += stepNanos
        let target = currentNanos
        var ready: [Sleeper] = []
        var remaining: [Sleeper] = []
        for sleeper in sleepers {
            if sleeper.wakeAtNanos <= target {
                ready.append(sleeper)
            } else {
                remaining.append(sleeper)
            }
        }
        sleepers = remaining
        lock.unlock()

        ready.sort { $0.wakeAtNanos < $1.wakeAtNanos }
        for sleeper in ready {
            sleeper.continuation.resume()
        }
    }
}
