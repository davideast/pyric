import Foundation

/// An AsyncSequence emitting User? updates whenever the active user's ID token changes.
public struct IDTokenChangesSequence: AsyncSequence, @unchecked Sendable {
    public typealias Element = User?
    public typealias Failure = Never
    public typealias AsyncIterator = Iterator

    private let auth: Auth

    public init(_ auth: Auth) {
        self.auth = auth
    }

    public func makeAsyncIterator() -> Iterator {
        Iterator(auth: auth)
    }

    public struct Iterator: AsyncIteratorProtocol {
        private var streamIterator: AsyncStream<User?>.Iterator

        init(auth: Auth) {
            let stream = auth.idTokenDidChangeStream
            self.streamIterator = stream.makeAsyncIterator()
        }

        public mutating func next() async -> User?? {
            await streamIterator.next()
        }
    }
}
