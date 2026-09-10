import Foundation

/// Server-side placeholder sentinels resolved by the Realtime Database server upon write.
public enum ServerValue {
    /// Returns a server timestamp sentinel that resolves to epoch milliseconds on write.
    public static func timestamp() -> [String: Any] {
        return [".sv": "timestamp"]
    }

    /// Returns a server increment sentinel that atomically increments a numeric value by `delta`.
    public static func increment(_ delta: NSNumber) -> [String: Any] {
        return [".sv": ["increment": delta.doubleValue]]
    }

    /// Returns a server increment sentinel that atomically increments an integer value by `delta`.
    public static func increment(_ delta: Int) -> [String: Any] {
        return [".sv": ["increment": delta]]
    }

    /// Returns a server increment sentinel that atomically increments a floating-point value by `delta`.
    public static func increment(_ delta: Double) -> [String: Any] {
        return [".sv": ["increment": delta]]
    }
}
