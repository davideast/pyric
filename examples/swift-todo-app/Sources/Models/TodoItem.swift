import Foundation
import PyricFirestore

public struct TodoItem: Identifiable, Sendable, Equatable {
    public let id: String
    public var title: String
    public var completed: Bool
    public var userId: String
    public var createdAt: Timestamp?

    public init(
        id: String,
        title: String,
        completed: Bool = false,
        userId: String = "",
        createdAt: Timestamp? = nil
    ) {
        self.id = id
        self.title = title
        self.completed = completed
        self.userId = userId
        self.createdAt = createdAt
    }

    /// Deserializes a TodoItem from a Firestore document snapshot data dictionary.
    public init?(id: String, data: [String: Any]) {
        guard let title = data["title"] as? String else {
            return nil
        }
        self.id = id
        self.title = title

        if let completed = data["completed"] as? Bool {
            self.completed = completed
        } else if let isDone = data["isDone"] as? Bool {
            self.completed = isDone
        } else if let done = data["done"] as? Bool {
            self.completed = done
        } else {
            self.completed = false
        }

        self.userId = (data["userId"] as? String) ?? ""

        if let ts = data["createdAt"] as? Timestamp {
            self.createdAt = ts
        } else if let date = data["createdAt"] as? Date {
            self.createdAt = Timestamp(date: date)
        } else {
            self.createdAt = nil
        }
    }

    /// Serializes the model into a dictionary suitable for Firestore operations.
    public var dictionaryRepresentation: [String: Any] {
        var dict: [String: Any] = [
            "title": title,
            "completed": completed,
            "userId": userId
        ]
        if let createdAt = createdAt {
            dict["createdAt"] = createdAt
        } else {
            dict["createdAt"] = FieldValue.serverTimestamp()
        }
        return dict
    }
}
