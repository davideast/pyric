import Foundation

/// An immutable object representing a geographical point in Firestore.
public struct GeoPoint: Equatable, Hashable, Sendable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        precondition(
            latitude.isFinite && latitude >= -90.0 && latitude <= 90.0,
            "GeoPoint requires a latitude value in the range of [-90, 90], but was \(latitude)"
        )
        precondition(
            longitude.isFinite && longitude >= -180.0 && longitude <= 180.0,
            "GeoPoint requires a longitude value in the range of [-180, 180], but was \(longitude)"
        )
        self.latitude = latitude
        self.longitude = longitude
    }
}

extension GeoPoint: Comparable {
    public static func < (lhs: GeoPoint, rhs: GeoPoint) -> Bool {
        if lhs.latitude != rhs.latitude {
            return lhs.latitude < rhs.latitude
        }
        return lhs.longitude < rhs.longitude
    }
}

extension GeoPoint: CustomStringConvertible {
    public var description: String {
        "<GeoPoint: (\(latitude), \(longitude))>"
    }
}

extension GeoPoint: Codable {
    private enum CodingKeys: String, CodingKey {
        case latitude
        case longitude
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let lat = try container.decode(Double.self, forKey: .latitude)
        let lng = try container.decode(Double.self, forKey: .longitude)
        self.init(latitude: lat, longitude: lng)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(latitude, forKey: .latitude)
        try container.encode(longitude, forKey: .longitude)
    }
}
