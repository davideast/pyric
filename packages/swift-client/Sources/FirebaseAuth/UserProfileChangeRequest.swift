import Foundation

/// Mutates a signed-in User's displayName and photoURL matching firebase-ios-sdk UserProfileChangeRequest.
public final class UserProfileChangeRequest: @unchecked Sendable {
    private let lock = NSLock()
    private let user: User
    private var _displayName: String?
    private var _photoURL: URL?

    internal init(user: User) {
        self.user = user
        self._displayName = user.displayName
        self._photoURL = user.photoURL
    }

    public var displayName: String? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _displayName
        }
        set {
            lock.lock()
            _displayName = newValue
            lock.unlock()
        }
    }

    public var photoURL: URL? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _photoURL
        }
        set {
            lock.lock()
            _photoURL = newValue
            lock.unlock()
        }
    }

    public func commitChanges() async throws {
        let snapshot: (String?, URL?) = {
            lock.lock()
            defer { lock.unlock() }
            return (_displayName, _photoURL)
        }()
        try await user.updateProfile(displayName: snapshot.0, photoURL: snapshot.1)
    }

    public func commitChanges(completion: (@Sendable (Error?) -> Void)?) {
        let snapshot: (String?, URL?) = {
            lock.lock()
            defer { lock.unlock() }
            return (_displayName, _photoURL)
        }()
        user.updateProfile(displayName: snapshot.0, photoURL: snapshot.1, completion: completion)
    }
}
