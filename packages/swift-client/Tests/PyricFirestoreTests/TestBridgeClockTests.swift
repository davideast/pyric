import Foundation
import Testing
@testable import PyricFirestore

@Suite("Test bridge clock")
struct TestBridgeClockTests {

    @Test("sleepUntil returns immediately when the clock is already at or past the deadline")
    func sleepUntilPastOrCurrentDeadlineReturnsImmediately() async throws {
        let clock = TestBridgeClock()
        let activeClock: any BridgeClock = clock
        clock.advance(by: 0.10)

        try await activeClock.sleepUntil(deadline: 0.10)
        try await activeClock.sleepUntil(deadline: 0.05)
        try await activeClock.sleepUntil(deadline: 0)
        #expect(clock.sleeperCount == 0)
    }

    @Test("sleepUntil dispatched through BridgeClock never parks past its deadline under concurrent advance")
    func sleepUntilDoesNotRaceWithConcurrentAdvance() async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    for _ in 0..<25 {
                        let clock = TestBridgeClock()
                        let activeClock: any BridgeClock = clock
                        let deadline = activeClock.now() + 0.02
                        let finished = Collected<Bool>()
                        let sleeper = Task {
                            try await activeClock.sleepUntil(deadline: deadline)
                            finished.append(true)
                        }
                        defer { sleeper.cancel() }

                        clock.advance(by: 0.02)
                        try await until { finished.count == 1 }
                        try await sleeper.value
                        #expect(clock.sleeperCount == 0)
                    }
                }
            }
            try await group.waitForAll()
        }
    }
}
