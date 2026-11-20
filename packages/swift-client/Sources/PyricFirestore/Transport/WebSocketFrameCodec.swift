import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Minimal RFC 6455 frame encoder/decoder shared with the POSIX loopback transport.
package enum WebSocketFrameCodec {
    package struct DecodedFrame: Sendable, Equatable {
        package let fin: Bool
        package let opcode: UInt8
        package let payload: [UInt8]
        package let bytesConsumed: Int
    }

    package static func randomMaskKey() -> [UInt8] {
        var rng = SystemRandomNumberGenerator()
        let raw = rng.next()
        return [
            UInt8(truncatingIfNeeded: raw >> 24),
            UInt8(truncatingIfNeeded: raw >> 16),
            UInt8(truncatingIfNeeded: raw >> 8),
            UInt8(truncatingIfNeeded: raw),
        ]
    }

    package static func encodeClientFrame(opcode: UInt8, payload: [UInt8], maskKey: [UInt8]) -> [UInt8] {
        precondition(maskKey.count == 4, "RFC 6455 client frames require a 4-byte mask key.")
        var frame: [UInt8] = []
        frame.reserveCapacity(14 + payload.count)
        frame.append(0x80 | (opcode & 0x0F))

        let length = payload.count
        if length < 126 {
            frame.append(0x80 | UInt8(length))
        } else if length <= 0xFFFF {
            frame.append(0x80 | 126)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(0x80 | 127)
            let len64 = UInt64(length)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((len64 >> shift) & 0xFF))
            }
        }

        frame.append(contentsOf: maskKey)
        for index in 0..<length {
            frame.append(payload[index] ^ maskKey[index & 3])
        }
        return frame
    }

    package static func decodeFrame(
        from buffer: ArraySlice<UInt8>,
        maxPayloadBytes: Int = 64 * 1024 * 1024
    ) throws -> DecodedFrame? {
        guard buffer.count >= 2 else { return nil }
        let start = buffer.startIndex
        let b0 = buffer[start]
        let b1 = buffer[start + 1]
        let fin = (b0 & 0x80) != 0
        let opcode = b0 & 0x0F
        let masked = (b1 & 0x80) != 0
        let len7 = Int(b1 & 0x7F)

        var headerLength = 2
        let payloadLength: Int
        if len7 < 126 {
            payloadLength = len7
        } else if len7 == 126 {
            guard buffer.count >= 4 else { return nil }
            payloadLength = (Int(buffer[start + 2]) << 8) | Int(buffer[start + 3])
            headerLength = 4
        } else {
            guard buffer.count >= 10 else { return nil }
            var len64: UInt64 = 0
            for offset in 2..<10 {
                len64 = (len64 << 8) | UInt64(buffer[start + offset])
            }
            guard len64 <= UInt64(maxPayloadBytes) else {
                throw PyricBridgeError.unavailable("WebSocket frame exceeded maximum size (\(len64) bytes).")
            }
            payloadLength = Int(len64)
            headerLength = 10
        }

        let maskLength = masked ? 4 : 0
        let totalHeader = headerLength + maskLength
        let totalFrame = totalHeader + payloadLength
        guard buffer.count >= totalFrame else { return nil }

        let payloadStart = start + totalHeader
        var payload = Array(buffer[payloadStart..<(payloadStart + payloadLength)])
        if masked {
            let maskStart = start + headerLength
            let mask = [
                buffer[maskStart],
                buffer[maskStart + 1],
                buffer[maskStart + 2],
                buffer[maskStart + 3],
            ]
            for index in 0..<payload.count {
                payload[index] ^= mask[index & 3]
            }
        }
        return DecodedFrame(fin: fin, opcode: opcode, payload: payload, bytesConsumed: totalFrame)
    }

    package static func encodeClosePayload(closeCode: Int, reason: String?) -> [UInt8] {
        let validCode = (closeCode >= 1000 && closeCode <= 4999) ? closeCode : 1000
        let code16 = UInt16(validCode)
        var out: [UInt8] = [UInt8((code16 >> 8) & 0xFF), UInt8(code16 & 0xFF)]
        if let reason, !reason.isEmpty {
            out.append(contentsOf: reason.utf8)
        }
        return out
    }

    package static func decodeClosePayload(_ payload: [UInt8]) -> (code: Int, reason: String?) {
        guard payload.count >= 2 else { return (1005, nil) }
        let code = (Int(payload[0]) << 8) | Int(payload[1])
        if payload.count == 2 {
            return (code, nil)
        }
        let reason = String(bytes: payload.dropFirst(2), encoding: .utf8)
        return (code, reason)
    }

    package static func buildUpgradeRequest(
        request: URLRequest,
        secKey: String
    ) throws -> (host: String, port: Int, bytes: [UInt8]) {
        guard let url = request.url else {
            throw PyricBridgeError.invalidArgument("Missing WebSocket endpoint URL.")
        }
        let scheme = (url.scheme ?? "ws").lowercased()
        guard scheme == "ws" else {
            throw PyricBridgeError.unavailable("POSIX WebSocket transport supports ws:// loopback endpoints only; got \(scheme).")
        }
        let host = url.host ?? "127.0.0.1"
        let port = url.port ?? 80
        let basePath = url.path.isEmpty ? "/" : url.path
        let requestTarget: String
        if let query = url.query, !query.isEmpty {
            requestTarget = "\(basePath)?\(query)"
        } else {
            requestTarget = basePath
        }
        let defaultHostHeader = url.port != nil ? "\(host):\(port)" : host
        let hostHeader = request.value(forHTTPHeaderField: "Host") ?? defaultHostHeader

        var lines: [String] = [
            "GET \(requestTarget) HTTP/1.1",
            "Host: \(hostHeader)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(secKey)",
            "Sec-WebSocket-Version: 13",
        ]
        let reserved: Set<String> = [
            "host", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version",
        ]
        if let extraHeaders = request.allHTTPHeaderFields {
            for (name, value) in extraHeaders.sorted(by: { $0.key < $1.key }) {
                if !reserved.contains(name.lowercased()) {
                    lines.append("\(name): \(value)")
                }
            }
        }
        let wire = lines.joined(separator: "\r\n") + "\r\n\r\n"
        return (host: host, port: port, bytes: Array(wire.utf8))
    }
}
