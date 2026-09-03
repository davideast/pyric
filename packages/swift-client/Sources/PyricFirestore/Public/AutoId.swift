import Foundation
import Security

public enum AutoId {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
    private static let alphabetSize: UInt8 = 62
    // 256 - (256 % 62) = 248. Any byte < 248 yields unbiased uniform modulo 62.
    private static let unbiasedLimit: UInt8 = 248

    public static func new() -> String {
        var idChars: [Character] = []
        idChars.reserveCapacity(20)

        var randomBuffer = [UInt8](repeating: 0, count: 40)
        while idChars.count < 20 {
            let status = SecRandomCopyBytes(kSecRandomDefault, randomBuffer.count, &randomBuffer)
            if status == errSecSuccess {
                for byte in randomBuffer where byte < unbiasedLimit {
                    idChars.append(alphabet[Int(byte % alphabetSize)])
                    if idChars.count == 20 { break }
                }
            } else {
                var rng = SystemRandomNumberGenerator()
                while idChars.count < 20 {
                    let val = rng.next()
                    let b = UInt8(truncatingIfNeeded: val)
                    if b < unbiasedLimit {
                        idChars.append(alphabet[Int(b % alphabetSize)])
                    }
                }
            }
        }
        return String(idChars)
    }
}
