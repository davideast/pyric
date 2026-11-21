import Foundation

/// Represents a single line in a Crashlytics custom exception stack trace,
/// mirroring `FirebaseCrashlytics.StackFrame` (`FIRStackFrame` in `firebase-ios-sdk:13.2.0`).
public final class StackFrame: NSObject, @unchecked Sendable {
    public let symbol: String?
    public let rawSymbol: String?
    public let library: String?
    public let fileName: String?
    public let lineNumber: UInt32
    public let offset: UInt64
    public let address: UInt64
    public let isSymbolicated: Bool

    @available(*, unavailable, message: "Use init(symbol:file:line:) or StackFrame.stackFrame(address:).")
    override public init() {
        fatalError("StackFrame cannot be initialized directly with init().")
    }

    /// Initializes a symbolicated `StackFrame` with a symbol name, file path, and line number.
    public init(symbol: String, file: String, line: Int) {
        self.symbol = symbol
        self.rawSymbol = nil
        self.library = nil
        self.fileName = file
        self.lineNumber = UInt32(truncatingIfNeeded: max(0, line))
        self.offset = 0
        self.address = 0
        self.isSymbolicated = true
        super.init()
    }

    /// Initializes an address-based `StackFrame` matching `+stackFrameWithAddress:`.
    public init(address: UInt) {
        self.symbol = nil
        self.rawSymbol = nil
        self.library = nil
        self.fileName = nil
        self.lineNumber = 0
        self.offset = 0
        self.address = UInt64(address)
        self.isSymbolicated = false
        super.init()
    }

    private init(rawSymbol: String) {
        self.symbol = rawSymbol
        self.rawSymbol = rawSymbol
        self.library = nil
        self.fileName = nil
        self.lineNumber = 0
        self.offset = 0
        self.address = 0
        self.isSymbolicated = false
        super.init()
    }

    /// Creates an address-based `StackFrame` matching `FIRStackFrame.stackFrame(withAddress:)`.
    public class func stackFrame(address: UInt) -> StackFrame {
        StackFrame(address: address)
    }

    /// Objective-C selector alias for `stackFrame(address:)`.
    public class func stackFrame(withAddress address: UInt) -> StackFrame {
        StackFrame(address: address)
    }

    /// Creates an unsymbolicated `StackFrame` carrying a raw symbol string.
    public class func stackFrame(symbol: String) -> StackFrame {
        StackFrame(rawSymbol: symbol)
    }

    override public var description: String {
        if isSymbolicated {
            let file = fileName ?? "(null)"
            let sym = symbol ?? "(null)"
            return "{\(file) - \(sym):\(lineNumber)}"
        }
        let hexAddress = String(address, radix: 16)
        if let fileName {
            let sym = symbol ?? "(null)"
            return "{[0x\(hexAddress)] \(fileName) - \(sym):\(lineNumber)}"
        }
        let sym = symbol ?? "(null)"
        return "{[0x\(hexAddress) + \(lineNumber)] \(sym)}"
    }
}
