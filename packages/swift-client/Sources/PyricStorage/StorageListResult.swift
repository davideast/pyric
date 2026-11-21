import Foundation

/// Contains the prefixes and items returned by a `StorageReference.list()` or `listAll()` call.
public final class StorageListResult: NSObject, Sendable {
    /// The prefixes (folders) returned by a `list()` operation.
    public let prefixes: [StorageReference]

    /// The objects (files) returned by a `list()` operation.
    public let items: [StorageReference]

    /// A token that can be used to resume a previous `list()` operation, or `nil` when complete.
    public let pageToken: String?

    package init(
        prefixes: [StorageReference],
        items: [StorageReference],
        pageToken: String? = nil
    ) {
        self.prefixes = prefixes
        self.items = items
        self.pageToken = pageToken
        super.init()
    }

    override public func copy() -> Any {
        StorageListResult(prefixes: prefixes, items: items, pageToken: pageToken)
    }

    override public func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? StorageListResult else {
            return false
        }
        return prefixes == other.prefixes
            && items == other.items
            && pageToken == other.pageToken
    }

    override public var hash: Int {
        var hasher = Hasher()
        hasher.combine(prefixes)
        hasher.combine(items)
        hasher.combine(pageToken)
        return hasher.finalize()
    }
}
