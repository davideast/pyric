import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

#if !canImport(Darwin)
import Glibc

/// Zero-dependency RFC 6455 loopback client WebSocket transport over POSIX Glibc sockets for Linux.
public final class POSIXWebSocketTransport: WebSocketTransport, @unchecked Sendable {
    private let request: URLRequest
    private let stateLock = NSLock()
    private let writeLock = NSLock()
    private let connectQueue: DispatchQueue
    private let sendQueue: DispatchQueue
    private let recvQueue: DispatchQueue

    private var fd: Int32 = -1
    private var closed = false
    private var connecting = false
    private var connectResult: Result<Int32, Error>?
    private var connectWaiters: [CheckedContinuation<Int32, Error>] = []
    private var inboundBuffer: [UInt8] = []

    public init(request: URLRequest) {
        self.request = request
        let id = UUID().uuidString
        self.connectQueue = DispatchQueue(label: "dev.pyric.ws.connect.\(id)")
        self.sendQueue = DispatchQueue(label: "dev.pyric.ws.send.\(id)")
        self.recvQueue = DispatchQueue(label: "dev.pyric.ws.recv.\(id)")
    }

    public func send(_ string: String) async throws {
        guard !isClosed else { throw WebSocketSendRefusedError() }
        let activeFd: Int32
        do {
            activeFd = try await ensureConnected()
        } catch {
            if isClosed { throw WebSocketSendRefusedError() }
            throw error
        }
        guard !isClosed else { throw WebSocketSendRefusedError() }

        let frame = WebSocketFrameCodec.encodeClientFrame(
            opcode: 0x01,
            payload: Array(string.utf8),
            maskKey: WebSocketFrameCodec.randomMaskKey()
        )
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sendQueue.async { [self] in
                if self.isClosed {
                    continuation.resume(throwing: WebSocketSendRefusedError())
                    return
                }
                do {
                    try self.writeAllLocked(fd: activeFd, bytes: frame)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    public func receive() async throws -> String {
        let activeFd = try await ensureConnected()
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            recvQueue.async { [self] in
                do {
                    let message = try self.readNextTextMessage(fd: activeFd)
                    continuation.resume(returning: message)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    public func close(closeCode: Int = 1000, reason: String? = nil) async {
        let socketToClose = markClosedAndTakeDescriptor()
        guard socketToClose >= 0 else { return }

        let closePayload = WebSocketFrameCodec.encodeClosePayload(closeCode: closeCode, reason: reason)
        let closeFrame = WebSocketFrameCodec.encodeClientFrame(
            opcode: 0x08,
            payload: closePayload,
            maskKey: WebSocketFrameCodec.randomMaskKey()
        )
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            sendQueue.async { [self] in
                try? self.writeAllLocked(fd: socketToClose, bytes: closeFrame)
                _ = Glibc.shutdown(socketToClose, Int32(Glibc.SHUT_RDWR))
                self.recvQueue.async {
                    _ = Glibc.close(socketToClose)
                    continuation.resume()
                }
            }
        }
    }

    private var isClosed: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return closed
    }

    private func markClosedAndTakeDescriptor() -> Int32 {
        stateLock.lock()
        closed = true
        let active = fd
        fd = -1
        let waiters = connectWaiters
        connectWaiters.removeAll()
        if connectResult == nil {
            connectResult = .failure(PyricBridgeError.unavailable("WebSocket transport is closed."))
        }
        stateLock.unlock()

        for waiter in waiters {
            waiter.resume(throwing: PyricBridgeError.unavailable("WebSocket transport is closed."))
        }
        return active
    }

    private func ensureConnected() async throws -> Int32 {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, Error>) in
            stateLock.lock()
            if closed {
                stateLock.unlock()
                continuation.resume(throwing: PyricBridgeError.unavailable("WebSocket transport is closed."))
                return
            }
            if let existing = connectResult {
                stateLock.unlock()
                continuation.resume(with: existing)
                return
            }
            connectWaiters.append(continuation)
            let shouldStart = !connecting
            connecting = true
            stateLock.unlock()

            guard shouldStart else { return }
            connectQueue.async { [self] in
                let outcome = Result { try self.openSocketAndUpgrade() }
                self.stateLock.lock()
                self.connecting = false
                if self.closed {
                    let waiters = self.connectWaiters
                    self.connectWaiters.removeAll()
                    self.stateLock.unlock()
                    if case .success(let opened) = outcome {
                        _ = Glibc.shutdown(opened.fd, Int32(Glibc.SHUT_RDWR))
                        _ = Glibc.close(opened.fd)
                    }
                    for waiter in waiters {
                        waiter.resume(throwing: PyricBridgeError.unavailable("WebSocket transport is closed."))
                    }
                    return
                }
                let mapped: Result<Int32, Error>
                switch outcome {
                case .success(let opened):
                    self.fd = opened.fd
                    self.inboundBuffer = opened.leftover
                    mapped = .success(opened.fd)
                case .failure(let error):
                    mapped = .failure(error)
                }
                self.connectResult = mapped
                let waiters = self.connectWaiters
                self.connectWaiters.removeAll()
                self.stateLock.unlock()
                for waiter in waiters {
                    waiter.resume(with: mapped)
                }
            }
        }
    }

    private func openSocketAndUpgrade() throws -> (fd: Int32, leftover: [UInt8]) {
        var keyBytes = [UInt8](repeating: 0, count: 16)
        var rng = SystemRandomNumberGenerator()
        for index in 0..<16 {
            keyBytes[index] = UInt8(truncatingIfNeeded: rng.next())
        }
        let secKey = Data(keyBytes).base64EncodedString()
        let upgrade = try WebSocketFrameCodec.buildUpgradeRequest(request: request, secKey: secKey)

        let sockType = Int32(Glibc.SOCK_STREAM.rawValue)
        let sockFd = Glibc.socket(Glibc.AF_INET, sockType, 0)
        guard sockFd >= 0 else {
            throw PyricBridgeError.unavailable("Failed to allocate POSIX socket (errno \(currentErrno())).")
        }

        do {
            var nodelay: Int32 = 1
            let tcpNoDelayOption: Int32 = 1
            _ = Glibc.setsockopt(
                sockFd,
                Int32(Glibc.IPPROTO_TCP),
                tcpNoDelayOption,
                &nodelay,
                socklen_t(MemoryLayout<Int32>.size)
            )
            try connectIPv4(fd: sockFd, host: upgrade.host, port: upgrade.port)
            try writeAllLocked(fd: sockFd, bytes: upgrade.bytes)
            let leftover = try readUpgradeResponse(fd: sockFd)
            return (fd: sockFd, leftover: leftover)
        } catch {
            _ = Glibc.close(sockFd)
            throw error
        }
    }

    private func connectIPv4(fd: Int32, host: String, port: Int) throws {
        guard port > 0 && port <= 65535 else {
            throw PyricBridgeError.invalidArgument("Invalid WebSocket port: \(port)")
        }
        let resolvedHost = (host == "localhost" || host.isEmpty) ? "127.0.0.1" : host
        var addr = Glibc.sockaddr_in()
        addr.sin_family = sa_family_t(Glibc.AF_INET)
        addr.sin_port = UInt16(port).bigEndian

        let parsed = resolvedHost.withCString { cstr in
            Glibc.inet_pton(Glibc.AF_INET, cstr, &addr.sin_addr)
        }
        if parsed == 1 {
            let rc = withUnsafePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: Glibc.sockaddr.self, capacity: 1) { sockPtr in
                    Glibc.connect(fd, sockPtr, socklen_t(MemoryLayout<Glibc.sockaddr_in>.size))
                }
            }
            guard rc == 0 else {
                throw PyricBridgeError.unavailable("Failed to connect to \(resolvedHost):\(port) (errno \(currentErrno())).")
            }
            return
        }

        var hints = Glibc.addrinfo()
        hints.ai_family = Glibc.AF_INET
        hints.ai_socktype = Int32(Glibc.SOCK_STREAM.rawValue)
        var infoPtr: UnsafeMutablePointer<Glibc.addrinfo>?
        let gai = resolvedHost.withCString { hostCStr in
            "\(port)".withCString { portCStr in
                Glibc.getaddrinfo(hostCStr, portCStr, &hints, &infoPtr)
            }
        }
        guard gai == 0, let firstInfo = infoPtr else {
            throw PyricBridgeError.unavailable("Unable to resolve WebSocket host \(resolvedHost):\(port).")
        }
        defer { Glibc.freeaddrinfo(firstInfo) }
        guard let aiAddr = firstInfo.pointee.ai_addr else {
            throw PyricBridgeError.unavailable("Resolved empty address for \(resolvedHost):\(port).")
        }
        let rc = Glibc.connect(fd, aiAddr, firstInfo.pointee.ai_addrlen)
        guard rc == 0 else {
            throw PyricBridgeError.unavailable("Failed to connect to \(resolvedHost):\(port) (errno \(currentErrno())).")
        }
    }

    private func readUpgradeResponse(fd: Int32) throws -> [UInt8] {
        var headerBuf: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: 4096)
        let delimiter: [UInt8] = [13, 10, 13, 10]
        while headerBuf.count < 65536 {
            let count = chunk.withUnsafeMutableBytes { rawBuf -> Int in
                guard let base = rawBuf.baseAddress else { return -1 }
                while true {
                    let n = Glibc.recv(fd, base, chunk.count, 0)
                    if n < 0 && self.currentErrno() == Glibc.EINTR { continue }
                    return n
                }
            }
            guard count > 0 else {
                throw PyricBridgeError.unavailable("WebSocket upgrade closed before HTTP 101 response.")
            }
            headerBuf.append(contentsOf: chunk[0..<count])
            if let range = headerBuf.firstRange(of: delimiter) {
                let headerSlice = headerBuf[0..<range.lowerBound]
                guard let headerText = String(bytes: headerSlice, encoding: .utf8),
                      let statusLine = headerText.components(separatedBy: "\r\n").first,
                      statusLine.contains(" 101 ") || statusLine.hasSuffix(" 101") else {
                    throw PyricBridgeError.unavailable("WebSocket upgrade rejected by server.")
                }
                return Array(headerBuf[range.upperBound...])
            }
        }
        throw PyricBridgeError.unavailable("WebSocket upgrade response headers exceeded 64 KiB.")
    }

    private func readNextTextMessage(fd: Int32) throws -> String {
        var fragmentBytes: [UInt8] = []
        var collectingFragments = false
        var chunk = [UInt8](repeating: 0, count: 16384)

        while true {
            while try WebSocketFrameCodec.decodeFrame(from: inboundBuffer[...]) == nil {
                let count = chunk.withUnsafeMutableBytes { rawBuf -> Int in
                    guard let base = rawBuf.baseAddress else { return -1 }
                    while true {
                        let n = Glibc.recv(fd, base, chunk.count, 0)
                        if n < 0 && self.currentErrno() == Glibc.EINTR { continue }
                        return n
                    }
                }
                if count <= 0 {
                    if isClosed {
                        throw WebSocketCloseError(closeCode: 1000, reason: nil)
                    }
                    throw PyricBridgeError.unavailable("WebSocket connection closed by peer.")
                }
                inboundBuffer.append(contentsOf: chunk[0..<count])
            }

            guard let frame = try WebSocketFrameCodec.decodeFrame(from: inboundBuffer[...]) else {
                continue
            }
            inboundBuffer.removeFirst(frame.bytesConsumed)

            switch frame.opcode {
            case 0x09:
                let pong = WebSocketFrameCodec.encodeClientFrame(
                    opcode: 0x0A,
                    payload: frame.payload,
                    maskKey: WebSocketFrameCodec.randomMaskKey()
                )
                try? writeAllLocked(fd: fd, bytes: pong)
            case 0x0A:
                continue
            case 0x08:
                let decoded = WebSocketFrameCodec.decodeClosePayload(frame.payload)
                if !isClosed {
                    let echoClose = WebSocketFrameCodec.encodeClientFrame(
                        opcode: 0x08,
                        payload: WebSocketFrameCodec.encodeClosePayload(closeCode: decoded.code, reason: nil),
                        maskKey: WebSocketFrameCodec.randomMaskKey()
                    )
                    try? writeAllLocked(fd: fd, bytes: echoClose)
                    let socketToClose = markClosedAndTakeDescriptor()
                    if socketToClose >= 0 {
                        _ = Glibc.shutdown(socketToClose, Int32(Glibc.SHUT_RDWR))
                        _ = Glibc.close(socketToClose)
                    }
                }
                throw WebSocketCloseError(closeCode: decoded.code, reason: decoded.reason)
            case 0x01, 0x02:
                fragmentBytes = frame.payload
                if frame.fin {
                    guard let text = String(bytes: fragmentBytes, encoding: .utf8) else {
                        throw PyricBridgeError.unavailable("Received non-UTF8 frame from bridge")
                    }
                    return text
                }
                collectingFragments = true
            case 0x00:
                guard collectingFragments else {
                    throw PyricBridgeError.unavailable("Unexpected WebSocket continuation frame")
                }
                fragmentBytes.append(contentsOf: frame.payload)
                if frame.fin {
                    guard let text = String(bytes: fragmentBytes, encoding: .utf8) else {
                        throw PyricBridgeError.unavailable("Received non-UTF8 fragmented frame from bridge")
                    }
                    return text
                }
            default:
                throw PyricBridgeError.unavailable("Unsupported WebSocket opcode \(frame.opcode)")
            }
        }
    }

    private func writeAllLocked(fd: Int32, bytes: [UInt8]) throws {
        writeLock.lock()
        defer { writeLock.unlock() }
        try bytes.withUnsafeBytes { rawBuf in
            guard let base = rawBuf.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let sent = Glibc.send(
                    fd,
                    base.advanced(by: offset),
                    bytes.count - offset,
                    Int32(Glibc.MSG_NOSIGNAL)
                )
                if sent < 0 {
                    if self.currentErrno() == Glibc.EINTR { continue }
                    throw PyricBridgeError.unavailable("WebSocket socket write failed (errno \(self.currentErrno())).")
                }
                if sent == 0 {
                    throw PyricBridgeError.unavailable("WebSocket socket closed during write.")
                }
                offset += sent
            }
        }
    }

    private func currentErrno() -> Int32 {
        Glibc.__errno_location().pointee
    }
}
#endif
