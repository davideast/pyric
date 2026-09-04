import Foundation

/// An AsyncSequence emitting User? updates whenever authentication state changes.
public struct AuthStateChangesSequence: AsyncSequence, @unchecked Sendable {
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
            let stream = auth.authStateDidChangeStream
            self.streamIterator = stream.makeAsyncIterator()
        }

        public mutating func next() async -> User?? {
            await streamIterator.next()
        }
    }
}
