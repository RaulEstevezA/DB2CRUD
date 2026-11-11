// Base of the tests: a new application for each test, so each one starts with empty storage.

@testable import App
import Foundation
import Testing
import VaporTesting

/// Runs a test on a new application, so each one starts with empty storage.
func withApi(_ test: (Api) async throws -> Void) async throws {
    let settings = Settings()
    let app = try await Application.make(.testing)
    do {
        try await configure(app, settings: settings)
        try await test(Api(app: app))
    } catch {
        try? await app.asyncShutdown()
        throw error
    }
    try await app.asyncShutdown()
}

/// Headers of a client allowed to call every endpoint.
func headers() async throws -> HTTPHeaders {
    HTTPHeaders()
}

/// The answer of a request in a test: its status and its JSON body (null when it has none).
struct TestResponse {
    let status: UInt
    let text: String
    let json: JSONValue
}

/// The application under test, called through its router.
struct Api {
    let app: Application

    func get(_ path: String, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.GET, path, nil, headers)
    }

    func post(_ path: String, _ body: JSONValue, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.POST, path, body, headers)
    }

    func put(_ path: String, _ body: JSONValue, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.PUT, path, body, headers)
    }

    func patch(_ path: String, _ body: JSONValue, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.PATCH, path, body, headers)
    }

    func delete(_ path: String, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.DELETE, path, nil, headers)
    }

    /// Sends a request, with a JSON body when there is one.
    func send(_ method: HTTPMethod, _ path: String, _ body: JSONValue?, _ headers: HTTPHeaders) async throws -> TestResponse {
        var headers = headers
        var buffer: ByteBuffer?
        if let body {
            headers.contentType = .json
            buffer = ByteBuffer(bytes: try JSONCoding.encoder().encode(body))
        }
        let response = try await app.testing().sendRequest(method, path, headers: headers, body: buffer)
        let text = response.body.string
        let json = (try? JSONCoding.decoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .null
        return TestResponse(status: response.status.code, text: text, json: json)
    }
}

extension Api {
    /// A valid body to create an author, with the items it refers to created first.
    func authorPayload(_ variant: Int = 0) async throws -> JSONValue {
        let body = variant == 0 ? parse("{\"name\":\"name 1\",\"email\":\"user1@example.com\",\"born\":\"2024-01-15\"}") : parse("{\"name\":\"name 2\",\"email\":\"user2@example.com\",\"born\":\"2024-01-16\"}")
        return body
    }

    /// Creates an author and returns it as the API answers.
    func createAuthor(_ variant: Int = 0) async throws -> JSONValue {
        let response = try await post("/authors", authorPayload(variant), headers())
        #expect(response.status == 201, "\(response.text)")
        return response.json
    }

    /// A valid body to create a book, with the items it refers to created first.
    func bookPayload(_ variant: Int = 0) async throws -> JSONValue {
        var body = variant == 0 ? parse("{\"title\":\"title 1\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"novel\",\"pages\":1,\"published\":\"2024-01-15\",\"available\":true}") : parse("{\"title\":\"title 2\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"essay\",\"pages\":2,\"published\":\"2024-01-16\",\"available\":false}")
        body = with(body, "/authorId", try await createAuthor()["id"])
        return body
    }

    /// Creates a book and returns it as the API answers.
    func createBook(_ variant: Int = 0) async throws -> JSONValue {
        let response = try await post("/books", bookPayload(variant), headers())
        #expect(response.status == 201, "\(response.text)")
        return response.json
    }
}

extension JSONValue {
    /// The value of a field of an object; null when it is not there.
    subscript(field: String) -> JSONValue {
        if case .object(let object) = self { return object[field] ?? .null }
        return .null
    }

    func has(_ field: String) -> Bool {
        if case .object(let object) = self { return object[field] != nil }
        return false
    }

    /// How many items a list has; nil when it is not a list.
    var count: Int? {
        if case .array(let items) = self { return items.count }
        return nil
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The text of a key, for a path.
    var text: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.rounded() == value ? String(Int64(value)) : String(value)
        default: return ""
        }
    }
}

/// A JSON value from its text.
func parse(_ text: String) -> JSONValue {
    (try? JSONCoding.decoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .null
}

/// A copy of a JSON value with another value at a JSON pointer: "/lines/0/productId".
func with(_ value: JSONValue, _ pointer: String, _ new: JSONValue) -> JSONValue {
    let steps = pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map {
        $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
    }
    return replacing(value, ArraySlice(steps), new)
}

private func replacing(_ value: JSONValue, _ steps: ArraySlice<String>, _ new: JSONValue) -> JSONValue {
    guard let step = steps.first else { return new }
    switch value {
    case .object(var object):
        object[step] = replacing(object[step] ?? .object([:]), steps.dropFirst(), new)
        return .object(object)
    case .array(var items):
        if let index = Int(step), items.indices.contains(index) {
            items[index] = replacing(items[index], steps.dropFirst(), new)
        }
        return .array(items)
    default:
        return value
    }
}

/// A copy of a JSON object without a field.
func without(_ value: JSONValue, _ field: String) -> JSONValue {
    guard case .object(var object) = value else { return value }
    object[field] = nil
    return .object(object)
}
