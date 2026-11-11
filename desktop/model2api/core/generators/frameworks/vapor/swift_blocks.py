"""The Swift code of the Vapor project that does not change with the model, written once for every project.
Mirrors the String.raw blocks of web/src/core/generators/frameworks/vapor/common.ts and tests.ts.
"""

API_ERROR = r"""
/// Where the request is wrong and why.
struct ErrorDetail: Codable, Sendable {
    let field: String
    let message: String
}

/// An error the API answers with a status, a code and a message (see openapi.yaml).
struct ApiError: Error, Sendable {
    let status: HTTPStatus
    let code: String
    let message: String
    var details: [ErrorDetail] = []

    /// A request that breaks its rules, with each problem.
    static func invalidBody(_ details: [ErrorDetail]) -> ApiError {
        ApiError(status: .badRequest, code: "validation_error", message: "The request is not valid", details: details)
    }

    static func invalid(_ field: String, _ message: String) -> ApiError {
        invalidBody([ErrorDetail(field: field, message: message)])
    }

    static func notFound(_ what: String) -> ApiError {
        ApiError(status: .notFound, code: "not_found", message: "No \(what) has this key")
    }

    static func conflict(_ message: String) -> ApiError {
        ApiError(status: .conflict, code: "conflict", message: message)
    }

    static func unauthorized() -> ApiError {
        ApiError(status: .unauthorized, code: "unauthorized", message: "Missing or invalid credentials")
    }

    static func forbidden() -> ApiError {
        ApiError(status: .forbidden, code: "forbidden", message: "The credentials do not allow this operation")
    }

    /// Code still to write: the API answers 501.
    static func notImplemented(_ message: String) -> ApiError {
        ApiError(status: .notImplemented, code: "not_implemented", message: message)
    }"""

MIDDLEWARE_TAIL = r"""
    /// The error as the API answers it.
    private func errorResponse(_ error: ApiError) -> Response {
        let body = ErrorEnvelope(error: ErrorBody(code: error.code, message: error.message, details: error.details.isEmpty ? nil : error.details))
        return (try? jsonResponse(error.status, body)) ?? Response(status: error.status)
    }

    /// Whether a route takes this path with another method.
    private func acceptsOtherMethod(_ request: Request) -> Bool {
        let parts = request.url.path.split(separator: "/").map(String.init)
        return request.application.routes.all.contains { route in
            route.method != request.method && matches(route.path, parts)
        }
    }

    private func matches(_ path: [PathComponent], _ parts: [String]) -> Bool {
        guard path.count == parts.count else { return false }
        for (component, part) in zip(path, parts) {
            switch component {
            case .constant(let text) where text != part:
                return false
            case .catchall:
                return true
            default:
                continue
            }
        }
        return true
    }
}

private struct ErrorEnvelope: Encodable {
    let error: ErrorBody
}

private struct ErrorBody: Encodable {
    let code: String
    let message: String
    let details: [ErrorDetail]?
}"""

JSON = r"""
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
}"""

BODY = r"""
/// A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not).
struct Body<T: Sendable>: Sendable {
    let value: T
    let sent: Set<String>

    func has(_ field: String) -> Bool {
        sent.contains(field)
    }
}

/// The kinds of JSON value a field can hold.
enum JsonKind: String {
    case text
    case whole = "whole number"
    case number
    case boolean
    case list
    case object
}

/// The rules of a body or an embedded object, run on its JSON.
typealias Rules = (inout Checks, [String: JSONValue]) -> Void

/// The problems of a request body, by field. Embedded objects add their path: address.street.
struct Checks {
    private(set) var problems: [ErrorDetail] = []
    private var prefix = ""

    mutating func fail(_ field: String, _ message: String) {
        problems.append(ErrorDetail(field: prefix + field, message: message))
    }

    /// Every field is one the contract describes.
    mutating func only(_ json: [String: JSONValue], _ fields: Set<String>) {
        for field in json.keys.sorted() where !fields.contains(field) {
            fail(field, "The field is not part of the contract")
        }
    }

    mutating func required(_ json: [String: JSONValue], _ field: String) {
        if json[field] == nil {
            fail(field, "The field is required")
        }
    }

    mutating func notNull(_ json: [String: JSONValue], _ field: String) {
        if json[field] == .null {
            fail(field, "The field must not be null")
        }
    }

    /// The value has the kind of the field; null is left to notNull.
    mutating func kind(_ json: [String: JSONValue], _ field: String, _ kind: JsonKind) {
        guard let value = json[field], value != .null else { return }
        let valid: Bool
        switch (kind, value) {
        case (.text, .string), (.number, .number), (.boolean, .bool), (.list, .array), (.object, .object):
            valid = true
        case (.whole, .number(let number)):
            valid = number.rounded() == number
        default:
            valid = false
        }
        if !valid {
            fail(field, "Must be \(kind.rawValue)")
        }
    }

    mutating func length(_ json: [String: JSONValue], _ field: String, min: Int?, max: Int?) {
        guard case .string(let text)? = json[field] else { return }
        // Counted as JavaScript counts: in UTF-16 units
        let length = text.utf16.count
        if min.map({ length < $0 }) ?? false || max.map({ length > $0 }) ?? false {
            fail(field, "Has a length out of its limits")
        }
    }

    mutating func count(_ json: [String: JSONValue], _ field: String, min: Int?, max: Int?) {
        guard case .array(let list)? = json[field] else { return }
        if min.map({ list.count < $0 }) ?? false || max.map({ list.count > $0 }) ?? false {
            fail(field, "Has a number of items out of its limits")
        }
    }

    mutating func range(_ json: [String: JSONValue], _ field: String, min: Double?, max: Double?, minExclusive: Bool, maxExclusive: Bool) {
        guard case .number(let number)? = json[field] else { return }
        let below = min.map { number < $0 || (minExclusive && number == $0) } ?? false
        let above = max.map { number > $0 || (maxExclusive && number == $0) } ?? false
        if below || above {
            fail(field, "Is out of its range")
        }
    }

    /// The text matches the expression somewhere, as "pattern" reads it in openapi.yaml.
    mutating func pattern(_ json: [String: JSONValue], _ field: String, _ pattern: String) {
        // An expression this engine cannot read checks nothing, rather than reject every value
        guard case .string(let text)? = json[field], let regex = try? NSRegularExpression(pattern: pattern) else { return }
        if regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil {
            fail(field, "Has the wrong format")
        }
    }

    mutating func email(_ json: [String: JSONValue], _ field: String) {
        guard case .string(let text)? = json[field] else { return }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        let valid = parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty && !text.contains(where: \.isWhitespace)
        if !valid {
            fail(field, "Must be an email address")
        }
    }

    /// The rules of an embedded object, with its path before each field.
    mutating func nested(_ json: [String: JSONValue], _ field: String, _ rules: Rules) {
        if case .object(let inner)? = json[field] {
            run(prefix + field + ".", inner, rules)
        }
    }

    /// The rules of each embedded object of a list.
    mutating func each(_ json: [String: JSONValue], _ field: String, _ rules: Rules) {
        guard case .array(let list)? = json[field] else { return }
        for (index, item) in list.enumerated() {
            if case .object(let inner) = item {
                run(prefix + field + "[\(index)].", inner, rules)
            }
        }
    }

    private mutating func run(_ prefix: String, _ json: [String: JSONValue], _ rules: Rules) {
        var inner = Checks()
        inner.prefix = prefix
        rules(&inner, json)
        problems.append(contentsOf: inner.problems)
    }
}

/// Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the
/// contract does not describe.
func readBody<T: Decodable & Sendable>(_ request: Request, as type: T.Type, rules: Rules) throws -> Body<T> {
    let data = request.body.data.map { Data(buffer: $0) } ?? Data()
    guard let json = try? JSONCoding.decoder().decode(JSONValue.self, from: data) else {
        throw ApiError.invalid("", "The body is not valid JSON")
    }
    guard case .object(let object) = json else {
        throw ApiError.invalid("", "The body must be a JSON object")
    }
    var checks = Checks()
    rules(&checks, object)
    if !checks.problems.isEmpty {
        throw ApiError.invalidBody(checks.problems)
    }
    guard let value = try? JSONCoding.decoder().decode(type, from: data) else {
        throw ApiError.invalid("", "The body does not match its type")
    }
    return Body(value: value, sent: Set(object.keys))
}"""

LIST = r"""
/// A list: the filters of its resource, an order by a JSON field name and a window.
struct ListQuery<F: Sendable>: Sendable {
    let filters: F
    let sortField: String?
    let descending: Bool
    let offset: Int
    let limit: Int?

    /// "-createdAt" sorts by createdAt in descending order.
    init(filters: F, sort: String?, offset: Int, limit: Int?) {
        self.filters = filters
        descending = sort?.hasPrefix("-") ?? false
        sortField = sort.map { $0.hasPrefix("-") ? String($0.dropFirst()) : $0 }
        self.offset = offset
        self.limit = limit
    }
}

/// A window of items and how many match, whatever the window.
struct ListResult<T: Sendable>: Sendable {
    let items: [T]
    let total: Int
}

/// One page of a list, as the API returns it.
struct PageResponse<T: Encodable & Sendable>: Encodable, Sendable {
    let items: [T]
    let total: Int
    let page: Int
    let size: Int
}

/// Whether a value of a field goes before another: the ones without a value go last, whatever the order. Nil when
/// they are equal.
func comesFirst<T: Comparable>(_ a: T?, _ b: T?, descending: Bool) -> Bool? {
    switch (a, b) {
    case let (a?, b?):
        if a == b { return nil }
        return descending ? a > b : a < b
    case (.some, .none):
        return true
    case (.none, .some):
        return false
    case (.none, .none):
        return nil
    }
}"""

QUERY = r"""
/// A whole number key of the path.
func intKey(_ request: Request, _ name: String) throws -> Int64 {
    guard let value = request.parameters.get(name).flatMap({ Int64($0) }) else {
        throw ApiError.invalid(name, "Must be a whole number")
    }
    return value
}

func uuidKey(_ request: Request, _ name: String) throws -> UUID {
    guard let value = request.parameters.get(name).flatMap(parseUUID) else {
        throw ApiError.invalid(name, "Must be a UUID")
    }
    return value
}

func textKey(_ request: Request, _ name: String) throws -> String {
    guard let value = request.parameters.get(name) else {
        throw ApiError.invalid(name, "Is missing")
    }
    return value
}

/// A whole number of the query string within its limits; the default when it is not there.
func intQuery(_ request: Request, _ name: String, default value: Int, min: Int, max: Int?) throws -> Int {
    guard let text = request.query[String.self, at: name] else { return value }
    guard let number = Int(text), number >= min, max.map({ number <= $0 }) ?? true else {
        throw ApiError.invalid(name, "Must be a whole number within its limits")
    }
    return number
}

/// A filter of the query string read with its type, or nil when it is not there; a malformed one is a 400.
func queryFilter<T>(_ request: Request, _ name: String, _ parse: (String) -> T?) throws -> T? {
    guard let text = request.query[String.self, at: name] else { return nil }
    guard let value = parse(text) else {
        throw ApiError.invalid(name, "Has the wrong format")
    }
    return value
}

/// A value of the query string that must be one of the choices.
func choiceQuery(_ request: Request, _ name: String, _ choices: [String]) throws -> String? {
    guard let text = request.query[String.self, at: name] else { return nil }
    guard choices.contains(text) else {
        throw ApiError.invalid(name, "Must be one of: \(choices.joined(separator: ", "))")
    }
    return text
}

/// A UUID written as 8-4-4-4-12 hexadecimal digits.
func parseUUID(_ text: String) -> UUID? {
    let canonical = text.count == 36 && text.enumerated().allSatisfy { index, char in
        [8, 13, 18, 23].contains(index) ? char == "-" : char.isHexDigit
    }
    return canonical ? UUID(uuidString: text) : nil
}

/// A date without time: ISO 8601 text, kept as it is.
func parseDate(_ text: String) -> String? {
    text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? text : nil
}

func parseBool(_ text: String) -> Bool? {
    text == "true" ? true : text == "false" ? false : nil
}"""

CLOCK = r"""
/// The time the server writes, in UTC.
enum ServerClock {
    /// Now, to the millisecond: what the API writes, so a later read gives the same value.
    static func now() -> Date {
        Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded(.down) / 1000)
    }

    /// Today as ISO 8601 text.
    static func today() -> String {
        Date().formatted(Date.ISO8601FormatStyle().year().month().day())
    }

    /// Now as ISO 8601 text, for a text field the server fills.
    static func text() -> String {
        formatDateTime(now())
    }
}"""

API_KEY_SECURITY = r"""
/// Who called a protected endpoint.
struct Authenticated: Sendable {}

/// API key authentication: a protected handler only runs with one of the keys in API_KEYS (header X-API-Key).
/// Without API_KEYS, no request is authenticated.
struct Security: Sendable {
    let settings: Settings

    static func make(_ settings: Settings) async -> Security {
        Security(settings: settings)
    }

    func authenticate(_ request: Request) async throws -> Authenticated {
        let key = request.headers.first(name: "x-api-key") ?? ""
        guard !key.isEmpty, settings.apiKeys.contains(where: { same($0, key) }) else {
            throw ApiError.unauthorized()
        }
        return Authenticated()
    }
}

/// Compares in constant time, so the answer time says nothing about the key.
private func same(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    return x.count == y.count && zip(x, y).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
}"""

JWT_SECURITY = r"""
/// What the API reads from a token: an expiry is required, the roles are in the "roles" claim.
struct Claims: JWTPayload {
    var exp: ExpirationClaim
    var roles: [String]?
    var aud: AudienceClaim?
    var iss: IssuerClaim?

    func verify(using algorithm: some JWTAlgorithm) async throws {
        try exp.verifyNotExpired()
    }
}

/// Who called a protected endpoint, with the roles of the token.
struct Authenticated: Sendable {
    let roles: [String]

    /// Rejects the call with 403 unless the token holds one of the roles.
    func requireRoles(_ roles: [String]) throws {
        guard roles.contains(where: self.roles.contains) else {
            throw ApiError.forbidden()
        }
    }
}

/// Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with
/// JWT_SECRET (HS256, and JWT_AUDIENCE / JWT_ISSUER when set).
struct Security: Sendable {
    let settings: Settings
    let keys: JWTKeyCollection

    static func make(_ settings: Settings) async -> Security {
        let keys = JWTKeyCollection()
        if !settings.jwtSecret.isEmpty {
            await keys.add(hmac: HMACKey(from: settings.jwtSecret), digestAlgorithm: .sha256)
        }
        return Security(settings: settings, keys: keys)
    }

    func authenticate(_ request: Request) async throws -> Authenticated {
        guard let token = request.headers.bearerAuthorization?.token, !settings.jwtSecret.isEmpty,
              let claims = try? await keys.verify(token, as: Claims.self) else {
            throw ApiError.unauthorized()
        }
        if !settings.jwtAudience.isEmpty, !(claims.aud?.value.contains(settings.jwtAudience) ?? false) {
            throw ApiError.unauthorized()
        }
        if !settings.jwtIssuer.isEmpty, claims.iss?.value != settings.jwtIssuer {
            throw ApiError.unauthorized()
        }
        return Authenticated(roles: claims.roles ?? [])
    }
}"""

SUPPORT = r"""
/// One test at a time on a shared database.
actor TestLock {
    static let shared = TestLock()
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if busy {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            busy = true
        }
    }

    func release() {
        if waiting.isEmpty {
            busy = false
        } else {
            waiting.removeFirst().resume()
        }
    }
}"""

CLIENT = r"""
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
}"""

HELPERS = r"""
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
}"""
