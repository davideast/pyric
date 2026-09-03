import Foundation

public final class SnapshotMetadata: Sendable, Equatable {
    public let hasPendingWrites: Bool
    public let isFromCache: Bool

    public init(hasPendingWrites: Bool = false, isFromCache: Bool = false) {
        self.hasPendingWrites = hasPendingWrites
        self.isFromCache = isFromCache
    }

    public static func == (lhs: SnapshotMetadata, rhs: SnapshotMetadata) -> Bool {
        lhs.hasPendingWrites == rhs.hasPendingWrites && lhs.isFromCache == rhs.isFromCache
    }
}
