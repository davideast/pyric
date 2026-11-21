import Foundation

// MARK: - Citations, Grounding, and URL Context Metadata

/// Source attribution for a span of generated text.
public struct Citation: Sendable, Equatable, Decodable {
    private struct WireProtoDate: Decodable {
        let year: Int?
        let month: Int?
        let day: Int?

        var dateComponents: DateComponents? {
            guard year != nil || month != nil || day != nil else { return nil }
            var dc = DateComponents()
            dc.calendar = Calendar(identifier: .gregorian)
            dc.year = year
            dc.month = month
            dc.day = day
            return dc
        }
    }

    public let startIndex: Int
    public let endIndex: Int
    public let uri: String?
    public let title: String?
    public let license: String?
    public let publicationDate: DateComponents?

    public init(
        startIndex: Int,
        endIndex: Int,
        uri: String? = nil,
        title: String? = nil,
        license: String? = nil,
        publicationDate: DateComponents? = nil
    ) {
        self.startIndex = startIndex
        self.endIndex = endIndex
        self.uri = uri
        self.title = title
        self.license = license
        self.publicationDate = publicationDate
    }

    var isEmpty: Bool {
        startIndex == 0 &&
            endIndex == 0 &&
            uri == nil &&
            title == nil &&
            license == nil &&
            publicationDate == nil
    }

    enum CodingKeys: String, CodingKey {
        case startIndex
        case endIndex
        case uri
        case title
        case license
        case publicationDate
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let start = try container.decodeIfPresent(Int.self, forKey: .startIndex) ?? 0
        self.startIndex = start
        self.endIndex = try container.decodeIfPresent(Int.self, forKey: .endIndex) ?? start
        let rawURI = try container.decodeIfPresent(String.self, forKey: .uri)
        self.uri = (rawURI?.isEmpty == false) ? rawURI : nil
        let rawTitle = try container.decodeIfPresent(String.self, forKey: .title)
        self.title = (rawTitle?.isEmpty == false) ? rawTitle : nil
        let rawLicense = try container.decodeIfPresent(String.self, forKey: .license)
        self.license = (rawLicense?.isEmpty == false) ? rawLicense : nil
        self.publicationDate = try container.decodeIfPresent(
            WireProtoDate.self,
            forKey: .publicationDate
        )?.dateComponents
    }
}

/// Collection of `Citation` attributions attached to a `Candidate`.
public struct CitationMetadata: Sendable, Equatable, Decodable {
    public let citations: [Citation]

    public init(citations: [Citation]) {
        self.citations = citations
    }

    enum CodingKeys: String, CodingKey {
        case citations
        case citationSources
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = try container.decodeIfPresent([Citation].self, forKey: .citationSources)
            ?? container.decodeIfPresent([Citation].self, forKey: .citations)
            ?? []
        self.citations = decoded.filter { !$0.isEmpty }
    }
}

/// Byte-offset span inside a `ModelContent` part referenced by grounding metadata.
public struct Segment: Sendable, Equatable, Hashable, Decodable {
    public let partIndex: Int
    public let startIndex: Int
    public let endIndex: Int
    public let text: String

    public init(partIndex: Int = 0, startIndex: Int = 0, endIndex: Int = 0, text: String = "") {
        self.partIndex = partIndex
        self.startIndex = startIndex
        self.endIndex = endIndex
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case partIndex
        case startIndex
        case endIndex
        case text
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.partIndex = try container.decodeIfPresent(Int.self, forKey: .partIndex) ?? 0
        self.startIndex = try container.decodeIfPresent(Int.self, forKey: .startIndex) ?? 0
        self.endIndex = try container.decodeIfPresent(Int.self, forKey: .endIndex) ?? 0
        self.text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
    }
}

/// Grounding attributions returned when Google Search or Google Maps grounding is enabled.
public struct GroundingMetadata: Sendable, Equatable, Hashable, Decodable {
    public struct SearchEntryPoint: Sendable, Equatable, Hashable, Decodable {
        public let renderedContent: String

        public init(renderedContent: String) {
            self.renderedContent = renderedContent
        }
    }

    public struct WebGroundingChunk: Sendable, Equatable, Hashable, Decodable {
        public let uri: String?
        public let title: String?
        public let domain: String?

        public init(uri: String? = nil, title: String? = nil, domain: String? = nil) {
            self.uri = uri
            self.title = title
            self.domain = domain
        }
    }

    public struct GoogleMapsGroundingChunk: Sendable, Equatable, Hashable, Decodable {
        public let uri: String?
        public let title: String?
        public let placeID: String?

        public init(uri: String? = nil, title: String? = nil, placeID: String? = nil) {
            self.uri = uri
            self.title = title
            self.placeID = placeID
        }

        enum CodingKeys: String, CodingKey {
            case uri
            case title
            case placeID = "placeId"
        }
    }

    public struct GroundingChunk: Sendable, Equatable, Hashable, Decodable {
        public let web: WebGroundingChunk?
        public let maps: GoogleMapsGroundingChunk?

        public init(web: WebGroundingChunk? = nil, maps: GoogleMapsGroundingChunk? = nil) {
            self.web = web
            self.maps = maps
        }
    }

    public struct GroundingSupport: Sendable, Equatable, Hashable, Decodable {
        public let segment: Segment
        public let groundingChunkIndices: [Int]

        public init(segment: Segment, groundingChunkIndices: [Int]) {
            self.segment = segment
            self.groundingChunkIndices = groundingChunkIndices
        }

        enum CodingKeys: String, CodingKey {
            case segment
            case groundingChunkIndices
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.segment = try container.decodeIfPresent(Segment.self, forKey: .segment) ?? Segment()
            self.groundingChunkIndices = try container.decodeIfPresent(
                [Int].self,
                forKey: .groundingChunkIndices
            ) ?? []
        }
    }

    public let webSearchQueries: [String]
    public let groundingChunks: [GroundingChunk]
    public let groundingSupports: [GroundingSupport]
    public let searchEntryPoint: SearchEntryPoint?

    public init(
        webSearchQueries: [String] = [],
        groundingChunks: [GroundingChunk] = [],
        groundingSupports: [GroundingSupport] = [],
        searchEntryPoint: SearchEntryPoint? = nil
    ) {
        self.webSearchQueries = webSearchQueries
        self.groundingChunks = groundingChunks
        self.groundingSupports = groundingSupports
        self.searchEntryPoint = searchEntryPoint
    }

    enum CodingKeys: String, CodingKey {
        case webSearchQueries
        case groundingChunks
        case groundingSupports
        case searchEntryPoint
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.webSearchQueries = try container.decodeIfPresent([String].self, forKey: .webSearchQueries) ?? []
        self.groundingChunks = try container.decodeIfPresent([GroundingChunk].self, forKey: .groundingChunks) ?? []
        self.groundingSupports = try container.decodeIfPresent(
            [GroundingSupport].self,
            forKey: .groundingSupports
        ) ?? []
        self.searchEntryPoint = try container.decodeIfPresent(SearchEntryPoint.self, forKey: .searchEntryPoint)
    }
}

/// Retrieval metadata for a single URL processed by `Tool.urlContext()`.
public struct URLMetadata: Sendable, Hashable, Equatable, Decodable {
    public struct URLRetrievalStatus: Sendable, Hashable, Equatable, Codable {
        public static let unspecified = URLRetrievalStatus(rawValue: "URL_RETRIEVAL_STATUS_UNSPECIFIED")
        public static let success = URLRetrievalStatus(rawValue: "URL_RETRIEVAL_STATUS_SUCCESS")
        public static let error = URLRetrievalStatus(rawValue: "URL_RETRIEVAL_STATUS_ERROR")
        public static let paywall = URLRetrievalStatus(rawValue: "URL_RETRIEVAL_STATUS_PAYWALL")
        public static let unsafe = URLRetrievalStatus(rawValue: "URL_RETRIEVAL_STATUS_UNSAFE")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            self.rawValue = try container.decode(String.self)
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public let retrievedURL: URL?
    public let retrievalStatus: URLRetrievalStatus

    public init(retrievedURL: URL?, retrievalStatus: URLRetrievalStatus) {
        self.retrievedURL = retrievedURL
        self.retrievalStatus = retrievalStatus
    }

    enum CodingKeys: String, CodingKey {
        case retrievedURL = "retrievedUrl"
        case retrievalStatus = "urlRetrievalStatus"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let raw = try container.decodeIfPresent(String.self, forKey: .retrievedURL),
           let parsed = URL(string: raw) {
            self.retrievedURL = parsed
        } else {
            self.retrievedURL = nil
        }
        self.retrievalStatus = try container.decodeIfPresent(
            URLRetrievalStatus.self,
            forKey: .retrievalStatus
        ) ?? .unspecified
    }
}

/// Metadata returned when `Tool.urlContext()` is used.
public struct URLContextMetadata: Sendable, Hashable, Equatable, Decodable {
    public let urlMetadata: [URLMetadata]

    public init(urlMetadata: [URLMetadata]) {
        self.urlMetadata = urlMetadata
    }

    enum CodingKeys: String, CodingKey {
        case urlMetadata
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.urlMetadata = try container.decodeIfPresent([URLMetadata].self, forKey: .urlMetadata) ?? []
    }
}
