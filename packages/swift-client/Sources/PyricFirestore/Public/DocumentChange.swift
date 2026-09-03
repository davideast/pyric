import Foundation

public enum DocumentChangeType: Int, Sendable, Equatable {
    case added = 0
    case modified = 1
    case removed = 2
}

public final class DocumentChange: Sendable, Equatable {
    public let type: DocumentChangeType
    public let document: QueryDocumentSnapshot
    public let oldIndex: Int
    public let newIndex: Int

    public static let indexNotFound: Int = -1

    public init(
        type: DocumentChangeType,
        document: QueryDocumentSnapshot,
        oldIndex: Int,
        newIndex: Int
    ) {
        self.type = type
        self.document = document
        self.oldIndex = oldIndex
        self.newIndex = newIndex
    }

    public static func == (lhs: DocumentChange, rhs: DocumentChange) -> Bool {
        lhs.type == rhs.type &&
        lhs.oldIndex == rhs.oldIndex &&
        lhs.newIndex == rhs.newIndex &&
        lhs.document.documentID == rhs.document.documentID
    }
}
