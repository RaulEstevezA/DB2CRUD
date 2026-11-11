// JSON values, the JSON coders of the API and JSON answers.

import Foundation
import Vapor

/// Any JSON value: request bodies are checked on it before they are decoded.
enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// The JSON of the API: date-times in ISO 8601 with milliseconds, keys in order.
enum JSONCoding {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDateTime(date))
        }
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = parseDateTime(text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date-time")
            }
            return date
        }
        return decoder
    }
}

/// A date-time as ISO 8601 text, to the nearest millisecond: a database that keeps dates as doubles may read back a
/// hair less than it stored.
func formatDateTime(_ date: Date) -> String {
    let rounded = Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1000).rounded() / 1000)
    return rounded.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
}

/// A date-time written in ISO 8601, with or without fractions of a second.
func parseDateTime(_ text: String) -> Date? {
    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text))
}

/// UUIDs are written in lower case.
func jsonUUID(_ value: UUID?) -> String? {
    value?.uuidString.lowercased()
}

func jsonUUIDs(_ values: [UUID]?) -> [String]? {
    values?.map { $0.uuidString.lowercased() }
}

/// A value stored as JSON text, and back.
func jsonText<T: Encodable>(_ value: T?) -> String? {
    guard let value, let data = try? JSONCoding.encoder().encode(value) else { return nil }
    return String(decoding: data, as: UTF8.self)
}

func jsonValue<T: Decodable>(_ text: String?, as type: T.Type) -> T? {
    guard let text else { return nil }
    return try? JSONCoding.decoder().decode(type, from: Data(text.utf8))
}

/// A JSON answer with a status.
func jsonResponse(_ status: HTTPStatus, _ value: some Encodable) throws -> Response {
    var headers = HTTPHeaders()
    headers.contentType = .json
    return Response(status: status, headers: headers, body: .init(data: try JSONCoding.encoder().encode(value)))
}
